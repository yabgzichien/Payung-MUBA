import { describe, it, expect } from 'vitest';
import { mergePreciseCommitment } from '../src/precise.js';
import { makeRawOnChainCommitment, FEED_ETH, FEED_BTC } from './fixtures.js';

const ethOrBtc = (feed: string) => (feed === FEED_BTC ? 'BTC' as const : 'ETH' as const);

describe('mergePreciseCommitment', () => {
  it('reconstructs the original spec from on-chain fields', () => {
    const raw = makeRawOnChainCommitment();
    const merged = mergePreciseCommitment(raw, null, [], ethOrBtc);
    expect(merged.spec.asset).toBe('ETH');
    expect(merged.spec.quantity).toBeCloseTo(1, 6);
    expect(merged.spec.floorTotalUsd).toBeCloseTo(2225, 2);
    expect(merged.spec.horizonDays).toBeCloseTo(30, 5);
  });

  it('resolves the commitment asset from the on-chain feed address via the supplied resolver', () => {
    const raw = makeRawOnChainCommitment({ underlyingFeed: FEED_BTC });
    const merged = mergePreciseCommitment(raw, null, [], ethOrBtc);
    expect(merged.spec.asset).toBe('BTC');
  });

  it('carries active/spend/roll fields through as plain numbers', () => {
    const raw = makeRawOnChainCommitment({ spentUsd: 34_500_000n, rollsUsed: 3n, active: false });
    const merged = mergePreciseCommitment(raw, null, [], ethOrBtc);
    expect(merged.active).toBe(false);
    expect(merged.spentUsd).toBeCloseTo(34.5, 6);
    expect(merged.rollsUsed).toBe(3);
    expect(merged.maxRolls).toBe(10);
    expect(merged.totalSpendCapUsd).toBeCloseTo(100, 6);
  });

  it('attaches the current leg when a matching position is supplied', () => {
    const raw = makeRawOnChainCommitment();
    const position = { id: 'pos-1', strike: 2225, daysToExpiry: 2.5 } as any;
    const merged = mergePreciseCommitment(raw, position, [], ethOrBtc);
    expect(merged.currentLeg).toBe(position);
  });

  it('carries roll history through unchanged, sorted oldest-first', () => {
    const raw = makeRawOnChainCommitment();
    const history = [
      { strike: 2225, expiryIso: '2026-10-01T00:00:00.000Z', premiumUsd: 9.27, txHash: '0xb' },
      { strike: 2225, expiryIso: '2026-09-25T00:00:00.000Z', premiumUsd: 8.5, txHash: '0xa' },
    ];
    const merged = mergePreciseCommitment(raw, null, history, ethOrBtc);
    expect(merged.history.map((h) => h.txHash)).toEqual(['0xa', '0xb']);
  });
});
