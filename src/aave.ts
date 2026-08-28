/**
 * USDC -> aBasUSDC via Aave V3 on Base.
 *
 * Buyable puts on the live book settle in aBasUSDC (Aave-wrapped USDC), not
 * raw USDC. This helper closes exactly that gap: if the wallet is short the
 * order's collateral token and that token is aBasUSDC, it supplies the
 * shortfall of raw USDC into the Aave pool (1:1, same 6 decimals) and gets
 * aBasUSDC back. Anything else is a loud, explicit "blocked".
 */
import { ethers } from 'ethers';
import { ThetanutsClient, STRATEGY_VAULT_CONFIG } from '@thetanuts-finance/thetanuts-client';
import { readClient, signerFromEnv, tokenSymbol } from './core.js';

const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
];

export type DepositPlan =
  | { action: 'none' }
  | { action: 'deposit'; supplyUnits: bigint }
  | { action: 'blocked'; reason: string };

/** Pure decision: what has to happen for the wallet to hold `neededUnits` of the collateral token. */
export function planDeposit(
  collateralBal: bigint,
  neededUnits: bigint,
  collateralSymbol: string,
  usdcBal: bigint
): DepositPlan {
  if (collateralBal >= neededUnits) return { action: 'none' };
  const shortfall = neededUnits - collateralBal;
  if (collateralSymbol !== 'aBasUSDC') {
    return {
      action: 'blocked',
      reason: `Short ${shortfall} units of ${collateralSymbol} and there is no auto-deposit path for it. Acquire it manually.`,
    };
  }
  if (usdcBal < shortfall) {
    return {
      action: 'blocked',
      reason: `Need ${shortfall} more units of aBasUSDC but the wallet only holds ${usdcBal} units of USDC. Top up USDC on Base first.`,
    };
  }
  return { action: 'deposit', supplyUnits: shortfall };
}

/**
 * Ensure the burner wallet holds `neededUnits` of `token` before a fill.
 * Executes the plan from `planDeposit`. Dry-runs the Aave supply with a free
 * staticCall before sending anything real.
 */
export async function ensureDollarCollateral(
  client: ThetanutsClient,
  token: string,
  neededUnits: bigint
): Promise<{ deposited: boolean; hash?: string }> {
  const provider = client.provider ?? readClient().provider!;
  const signer = signerFromEnv(provider);
  const me = await signer.getAddress();

  const usdcAddr = client.chainConfig.tokens.USDC.address;
  const [collateralBal, usdcBal, sym] = await Promise.all([
    client.erc20.getBalance(token, me),
    client.erc20.getBalance(usdcAddr, me),
    tokenSymbol(client, token),
  ]);

  const plan = planDeposit(BigInt(collateralBal), neededUnits, sym, BigInt(usdcBal));
  if (plan.action === 'none') return { deposited: false };
  if (plan.action === 'blocked') throw new Error(plan.reason);

  const pool = new ethers.Contract(STRATEGY_VAULT_CONFIG.aave.pool, AAVE_POOL_ABI, signer);

  // Exact-amount approval (never MaxUint256), then a FREE dry run before the real supply.
  await client.erc20.ensureAllowance(usdcAddr, STRATEGY_VAULT_CONFIG.aave.pool, plan.supplyUnits);
  await pool.supply.staticCall(usdcAddr, plan.supplyUnits, me, 0);
  const tx = await pool.supply(usdcAddr, plan.supplyUnits, me, 0);
  const receipt = await tx.wait();
  return { deposited: true, hash: receipt.hash };
}
