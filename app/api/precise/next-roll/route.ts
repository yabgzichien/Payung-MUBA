import type { NextRequest } from 'next/server';
import { ethers } from 'ethers';
import { readClient, findCandidates, quote } from '@/src/core';
import { positionsFor } from '@/src/watcher';
import { jsonResponse, withErrorHandling, ClientError } from '@/src/api-shared';

const MODULE_ADDRESS = process.env.PAYUNG_ROLL_MODULE_ADDRESS ?? '';
const ROLL_TRIGGER_DAYS = 2; // matches DEFAULT_POLICY.rollWhenDaysToExpiry in src/policy.ts

const MODULE_ABI = [
  'function commitments(address) view returns (address safe, bool isCall, address underlyingFeed, uint256 quantity1e6, uint256 targetStrike, uint256 createdAt, uint256 deadline, uint256 maxPremiumPerRollUsd, uint256 totalSpendCapUsd, uint256 spentUsd, uint256 maxRolls, uint256 rollsUsed, bool active)',
];

export async function GET(req: NextRequest) {
  return withErrorHandling(async () => {
    const safe = req.nextUrl.searchParams.get('safe');
    if (!safe || !ethers.isAddress(safe)) throw new ClientError('safe must be a valid address');
    if (!MODULE_ADDRESS) throw new Error('PAYUNG_ROLL_MODULE_ADDRESS is not configured on the server.');

    const client = readClient();
    const module = new ethers.Contract(MODULE_ADDRESS, MODULE_ABI, client.provider);
    const c = await module.commitments(safe);
    const nowSec = Math.floor(Date.now() / 1000);

    if (!c.active || nowSec >= Number(c.deadline)) {
      return jsonResponse(200, { due: false });
    }

    const targetStrike = Number(c.targetStrike) / 1e8;
    const positions = await positionsFor(safe, nowSec);
    const currentLeg = positions.find((p) => p.status === 'active' && p.strike === targetStrike) ?? null;
    // No active leg yet means this commitment was just opened and never rolled — roll immediately
    // rather than waiting for a "days to expiry" reading that doesn't exist yet.
    if (currentLeg && (currentLeg.daysToExpiry ?? 0) > ROLL_TRIGGER_DAYS) {
      return jsonResponse(200, { due: false });
    }

    const asset = (Object.entries(client.chainConfig.priceFeeds) as [string, string][]).find(
      ([, addr]) => addr.toLowerCase() === (c.underlyingFeed as string).toLowerCase()
    )?.[0] as 'ETH' | 'BTC' | undefined;
    if (!asset) throw new Error(`Unrecognized price feed on commitment: ${c.underlyingFeed}`);

    const quantity = Number(c.quantity1e6) / 1e6;
    const remainingDays = Math.max(1, Math.ceil((Number(c.deadline) - nowSec) / 86400));
    const candidates = await findCandidates(
      { asset, quantity, floorTotalUsd: targetStrike * quantity, horizonDays: remainingDays },
      client
    );
    if (candidates.length === 0) return jsonResponse(200, { due: false });

    const best = candidates[0];
    const q = await quote(best, quantity * best.pricePerContract, client);
    const usdcAmount = Math.round(q.premiumUsdc * 1e6);
    if (usdcAmount > Number(c.maxPremiumPerRollUsd) || Number(c.spentUsd) + usdcAmount > Number(c.totalSpendCapUsd)) {
      return jsonResponse(200, { due: false });
    }

    const { data: fillOrderCalldata } = client.optionBook.encodeFillOrder(best.raw, BigInt(usdcAmount));

    return jsonResponse(200, {
      due: true,
      safe,
      fillOrderCalldata,
      usdcAmount,
      orderStrike: Math.round(best.strike * 1e8),
      orderExpiry: Math.floor(best.expiry.getTime() / 1000),
    });
  });
}
