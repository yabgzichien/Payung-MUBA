import type { Candidate } from '../src/core.js';
import type { RawOnChainCommitment } from '../src/precise.js';
export type { RawOnChainCommitment };

// Fake but valid-shaped addresses. Tests never touch the network.
export const FEED_ETH = '0x00000000000000000000000000000000000000e1';
export const FEED_BTC = '0x00000000000000000000000000000000000000b1';
export const USDC = '0x00000000000000000000000000000000000000c1';
export const ABAS_USDC = '0x00000000000000000000000000000000000000a1';
export const WETH = '0x00000000000000000000000000000000000000f1';

export function makeCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    raw: { signature: '0xs1gdefault0000000000' },
    isCall: false,
    // takerIsBuyer: true is the buy-protection side (taker owes only the
    // premium). See the field docs in src/core.ts.
    takerIsBuyer: true,
    yourSide: 'you buy the option',
    strike: 2300,
    expiry: new Date('2026-09-10T08:00:00Z'),
    daysToExpiry: 14,
    pricePerContract: 19.94,
    collateralToken: ABAS_USDC,
    priceFeed: FEED_ETH,
    makerBudget: 5000,
    greeks: { iv: 0.55 },
    ...over,
  };
}

export function makeRawOnChainCommitment(over: Partial<RawOnChainCommitment> = {}): RawOnChainCommitment {
  return {
    safe: '0x00000000000000000000000000000000000005afe',
    active: true,
    underlyingFeed: FEED_ETH,
    quantity1e6: 1_000_000n,
    targetStrike: 222_500_000_000n, // $2,225 at 1e8
    createdAt: 1_800_000_000n,
    deadline: 1_802_592_000n, // +30 days
    maxPremiumPerRollUsd: 25_000_000n,
    totalSpendCapUsd: 100_000_000n,
    spentUsd: 0n,
    maxRolls: 10n,
    rollsUsed: 0n,
    ...over,
  };
}

