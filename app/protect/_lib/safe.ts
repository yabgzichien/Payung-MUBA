'use client';

import Safe from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import { getSigner, describeWalletError, type TxRequest } from './wallet';

const USDC_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

/** USDC currently sitting in the Safe, as a decimal amount. */
export async function safeUsdcBalance(safeAddress: string): Promise<number> {
  const signer = await getSigner();
  const usdc = new ethers.Contract(USDC_ADDRESS_BASE, ERC20_ABI, signer);
  const raw: bigint = await usdc.balanceOf(safeAddress);
  return Number(raw) / 10 ** USDC_DECIMALS;
}

/**
 * Sweeps every USDC the Safe holds back to its owner.
 *
 * This is the escape hatch for a setup that funded the Safe and then failed
 * before the module could be enabled. Without it, that USDC is reachable only
 * by someone who knows to go to the Safe UI and paste an address the app
 * never showed them — which, from the user's side, is indistinguishable from
 * the money being gone.
 */
export async function withdrawFromSafe(safeAddress: string): Promise<{ hash: string; amount: number }> {
  const signer = await getSigner();
  const owner = await signer.getAddress();
  try {
    const amount = await safeUsdcBalance(safeAddress);
    if (amount <= 0) throw new Error('This Safe holds no USDC to withdraw.');

    const protocolKit = await Safe.init({
      provider: (window as any).ethereum ?? 'https://mainnet.base.org',
      signer: owner,
      safeAddress,
    });
    const iface = new ethers.Interface(ERC20_ABI);
    const data = iface.encodeFunctionData('transfer', [
      owner,
      BigInt(Math.round(amount * 10 ** USDC_DECIMALS)),
    ]);
    const safeTx = await protocolKit.createTransaction({
      transactions: [{ to: USDC_ADDRESS_BASE, value: '0', data }],
    });
    const signedTx = await protocolKit.signTransaction(safeTx);
    const result = await protocolKit.executeTransaction(signedTx);
    return { hash: result.hash, amount };
  } catch (e) {
    throw new Error(describeWalletError(e));
  }
}

/**
 * The counterfactual address of this wallet's 1-of-1 Safe, WITHOUT deploying it.
 *
 * Safe addresses are deterministic in owner + config, which lets the setup
 * flow encode the on-chain commitment (which is keyed by Safe address) and
 * confirm the server is configured for it before any transaction is signed.
 */
export async function predictSafeAddress(): Promise<string> {
  const signer = await getSigner();
  const owner = await signer.getAddress();
  const protocolKit = await Safe.init({
    provider: (window as any).ethereum ?? 'https://mainnet.base.org',
    signer: owner,
    predictedSafe: { safeAccountConfig: { owners: [owner], threshold: 1 } },
  });
  return protocolKit.getAddress();
}

/** Deploys a fresh 1-owner Safe for the connected wallet, or returns an existing one if already deployed at the predicted address. */
export async function deployOrConnectSafe(): Promise<string> {
  const signer = await getSigner();
  const owner = await signer.getAddress();
  try {
    const protocolKit = await Safe.init({
      provider: (window as any).ethereum ?? 'https://mainnet.base.org',
      signer: owner,
      predictedSafe: { safeAccountConfig: { owners: [owner], threshold: 1 } },
    });
    const safeAddress = await protocolKit.getAddress();
    const deployed = await protocolKit.isSafeDeployed();
    if (deployed) return safeAddress;

    const deploymentTx = await protocolKit.createSafeDeploymentTransaction();
    const sent = await signer.sendTransaction({ to: deploymentTx.to, value: deploymentTx.value, data: deploymentTx.data });
    await sent.wait();
    return safeAddress;
  } catch (e) {
    throw new Error(describeWalletError(e));
  }
}

/** A plain ERC-20 transfer of USDC from the connected wallet into the Safe. */
export async function fundSafe(safeAddress: string, usdcAmount: number): Promise<{ hash: string }> {
  const signer = await getSigner();
  const usdc = new ethers.Contract(USDC_ADDRESS_BASE, ERC20_ABI, signer);
  const amount = BigInt(Math.round(usdcAmount * 10 ** USDC_DECIMALS));
  try {
    const tx = await usdc.transfer(safeAddress, amount);
    await tx.wait();
    return { hash: tx.hash };
  } catch (e) {
    throw new Error(describeWalletError(e));
  }
}

/**
 * Bundles "enable PayungRollModule" + the server-prepared open() call into one Safe multisend
 * transaction, and sends it. moduleAddress and openTx.to must be the same deployed module address.
 */
export async function enableModuleAndOpen(safeAddress: string, moduleAddress: string, openTx: TxRequest): Promise<{ hash: string }> {
  const signer = await getSigner();
  try {
    const protocolKit = await Safe.init({
      provider: (window as any).ethereum ?? 'https://mainnet.base.org',
      signer: await signer.getAddress(),
      safeAddress,
    });
    const safeTx = await protocolKit.createTransaction({
      transactions: [
        { to: safeAddress, value: '0', data: encodeEnableModule(moduleAddress) },
        { to: openTx.to, value: '0', data: openTx.data },
      ],
    });
    const signedTx = await protocolKit.signTransaction(safeTx);
    const result = await protocolKit.executeTransaction(signedTx);
    return { hash: result.hash };
  } catch (e) {
    throw new Error(describeWalletError(e));
  }
}

function encodeEnableModule(moduleAddress: string): string {
  const iface = new ethers.Interface(['function enableModule(address module)']);
  return iface.encodeFunctionData('enableModule', [moduleAddress]);
}
