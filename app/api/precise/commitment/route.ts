import { ethers } from 'ethers';
import type { NextRequest } from 'next/server';
import { readClient } from '@/src/core';
import { positionsFor } from '@/src/watcher';
import { mergePreciseCommitment, type RawOnChainCommitment, type RollHistoryEntry } from '@/src/precise';
import { jsonResponse, withErrorHandling, ClientError } from '@/src/api-shared';

const MODULE_ADDRESS = process.env.PAYUNG_ROLL_MODULE_ADDRESS ?? '';

const MODULE_ABI = [
  'function commitments(address) view returns (address safe, bool isCall, address underlyingFeed, uint256 quantity1e6, uint256 targetStrike, uint256 createdAt, uint256 deadline, uint256 maxPremiumPerRollUsd, uint256 totalSpendCapUsd, uint256 spentUsd, uint256 maxRolls, uint256 rollsUsed, bool active)',
  'event RollExecuted(address indexed safe, uint256 strike, uint256 expiry, uint256 premiumUsd, uint256 rollsUsed)',
];

export async function GET(req: NextRequest) {
  return withErrorHandling(async () => {
    const safe = req.nextUrl.searchParams.get('safe');
    if (!safe || !ethers.isAddress(safe)) {
      throw new ClientError('safe must be a valid address');
    }
    if (!MODULE_ADDRESS) {
      throw new Error('PAYUNG_ROLL_MODULE_ADDRESS is not configured on the server.');
    }

    const client = readClient();
    const module = new ethers.Contract(MODULE_ADDRESS, MODULE_ABI, client.provider);

    const raw = await module.commitments(safe);
    const isOpen = raw.createdAt !== 0n;
    if (!isOpen) {
      return jsonResponse(200, { commitment: null });
    }

    const rawCommitment: RawOnChainCommitment = {
      safe: raw.safe,
      active: raw.active,
      quantity1e6: raw.quantity1e6,
      targetStrike: raw.targetStrike,
      createdAt: raw.createdAt,
      deadline: raw.deadline,
      maxPremiumPerRollUsd: raw.maxPremiumPerRollUsd,
      totalSpendCapUsd: raw.totalSpendCapUsd,
      spentUsd: raw.spentUsd,
      maxRolls: raw.maxRolls,
      rollsUsed: raw.rollsUsed,
      underlyingFeed: raw.underlyingFeed,
    };

    const assetForFeed = (feed: string): 'ETH' | 'BTC' => {
      const entries = Object.entries(client.chainConfig.priceFeeds) as [string, string][];
      const match = entries.find(([, addr]) => addr.toLowerCase() === feed.toLowerCase());
      if (!match) throw new Error(`Unrecognized price feed on commitment: ${feed}`);
      return match[0] as 'ETH' | 'BTC';
    };

    const nowSec = Math.floor(Date.now() / 1000);
    const positions = await positionsFor(safe, nowSec);
    const currentLeg =
      positions.find((p) => p.status === 'active' && p.strike === Number(raw.targetStrike) / 1e8) ?? null;

    const events = await module.queryFilter(module.filters.RollExecuted(safe));
    const history: RollHistoryEntry[] = events.map((e: any) => ({
      strike: Number(e.args.strike) / 1e8,
      expiryIso: e.args.expiry ? new Date(Number(e.args.expiry) * 1000).toISOString() : '',
      premiumUsd: Number(e.args.premiumUsd) / 1e6,
      txHash: e.transactionHash,
    }));

    const commitment = mergePreciseCommitment(rawCommitment, currentLeg, history, assetForFeed);
    return jsonResponse(200, { commitment });
  });
}
