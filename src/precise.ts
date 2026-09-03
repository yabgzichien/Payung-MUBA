/**
 * Read/merge layer for Precise Protection. No new database (spec Invariant 6) — every field here
 * is reconstructed from the on-chain module's own storage/events, plus Thetanuts' existing
 * positions indexer via ShapedPosition. This module never signs or sends anything, and stays
 * SDK-free (mirrors src/spot.ts's boundary) — asset resolution is injected via assetForFeed rather
 * than resolved internally, so the caller (the API route, which does hold a client) supplies it.
 */
import type { ProtectionSpec } from './spec';
import type { ShapedPosition } from './positions';

export type RawOnChainCommitment = {
  safe: string;
  active: boolean;
  underlyingFeed: string;
  quantity1e6: bigint;
  targetStrike: bigint;
  createdAt: bigint;
  deadline: bigint;
  maxPremiumPerRollUsd: bigint;
  totalSpendCapUsd: bigint;
  spentUsd: bigint;
  maxRolls: bigint;
  rollsUsed: bigint;
};

export type RollHistoryEntry = { strike: number; expiryIso: string; premiumUsd: number; txHash: string };

export type PreciseCommitment = {
  safe: string;
  active: boolean;
  spec: ProtectionSpec;
  spentUsd: number;
  totalSpendCapUsd: number;
  rollsUsed: number;
  maxRolls: number;
  currentLeg: ShapedPosition | null;
  history: RollHistoryEntry[];
};

const USDC_SCALE = 1_000_000;
const STRIKE_SCALE = 100_000_000;
const DAY_SECONDS = 86_400;

export function mergePreciseCommitment(
  raw: RawOnChainCommitment,
  currentLeg: ShapedPosition | null,
  history: RollHistoryEntry[],
  assetForFeed: (feed: string) => 'ETH' | 'BTC'
): PreciseCommitment {
  const horizonDays = Number(raw.deadline - raw.createdAt) / DAY_SECONDS;
  const quantity = Number(raw.quantity1e6) / USDC_SCALE;
  const unitStrike = Number(raw.targetStrike) / STRIKE_SCALE;

  return {
    safe: raw.safe,
    active: raw.active,
    spec: {
      asset: assetForFeed(raw.underlyingFeed),
      quantity,
      floorTotalUsd: unitStrike * quantity,
      horizonDays,
    },
    spentUsd: Number(raw.spentUsd) / USDC_SCALE,
    totalSpendCapUsd: Number(raw.totalSpendCapUsd) / USDC_SCALE,
    rollsUsed: Number(raw.rollsUsed),
    maxRolls: Number(raw.maxRolls),
    currentLeg,
    history: [...history].sort((a, b) => new Date(a.expiryIso).getTime() - new Date(b.expiryIso).getTime()),
  };
}
