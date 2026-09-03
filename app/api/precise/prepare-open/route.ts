import { ethers } from 'ethers';
import { impliedStrike, type ProtectionSpec } from '@/src/spec';
import { validateSpec } from '@/src/intent';
import { ClientError, jsonResponse, requireJsonContentType, withErrorHandling } from '@/src/api-shared';

const MODULE_ADDRESS = process.env.PAYUNG_ROLL_MODULE_ADDRESS ?? '';
const STRIKE_SCALE = 100_000_000;
const USDC_SCALE = 1_000_000;

const MODULE_ABI = [
  'function open((address safe, bool isCall, address underlyingFeed, uint256 quantity1e6, uint256 targetStrike, uint256 createdAt, uint256 deadline, uint256 maxPremiumPerRollUsd, uint256 totalSpendCapUsd, uint256 spentUsd, uint256 maxRolls, uint256 rollsUsed, bool active))',
];

function parsePositiveNumber(raw: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ClientError(`${field} must be a positive finite number`);
  return n;
}

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    if (!MODULE_ADDRESS) throw new Error('PAYUNG_ROLL_MODULE_ADDRESS is not configured on the server.');
    const body = await req.json();

    let spec: ProtectionSpec;
    try {
      spec = validateSpec(body.spec);
    } catch (e: any) {
      throw new ClientError(e?.message ?? String(e));
    }
    if (typeof body.safe !== 'string' || !ethers.isAddress(body.safe)) {
      throw new ClientError('safe must be a valid address');
    }
    const maxPremiumPerRollUsd = parsePositiveNumber(body.maxPremiumPerRollUsd, 'maxPremiumPerRollUsd');
    const totalSpendCapUsd = parsePositiveNumber(body.totalSpendCapUsd, 'totalSpendCapUsd');
    const maxRolls = parsePositiveNumber(body.maxRolls, 'maxRolls');

    const feedEnv = spec.asset === 'ETH' ? process.env.CHAINLINK_FEED_ETH : process.env.CHAINLINK_FEED_BTC;
    if (!feedEnv) throw new Error(`No configured price feed for ${spec.asset}`);

    const nowSec = Math.floor(Date.now() / 1000);
    const commitment = {
      safe: body.safe,
      isCall: false,
      underlyingFeed: feedEnv,
      quantity1e6: BigInt(Math.round(spec.quantity * USDC_SCALE)),
      targetStrike: BigInt(Math.round(impliedStrike(spec) * STRIKE_SCALE)),
      createdAt: BigInt(nowSec),
      deadline: BigInt(nowSec + Math.round(spec.horizonDays * 86400)),
      maxPremiumPerRollUsd: BigInt(Math.round(maxPremiumPerRollUsd * USDC_SCALE)),
      totalSpendCapUsd: BigInt(Math.round(totalSpendCapUsd * USDC_SCALE)),
      spentUsd: 0n,
      maxRolls: BigInt(Math.round(maxRolls)),
      rollsUsed: 0n,
      active: false, // set true by open() itself — irrelevant here, encoded for struct-shape completeness
    };

    const iface = new ethers.Interface(MODULE_ABI);
    const data = iface.encodeFunctionData('open', [commitment]);

    return jsonResponse(200, { to: MODULE_ADDRESS, data });
  });
}
