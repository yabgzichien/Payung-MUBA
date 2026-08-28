import { describe, it, expect } from 'vitest';
import { candidateId, toWire, jsonSafe } from '../src/server.js';
import { makeCandidate } from './fixtures.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

describe('wire format', () => {
  it('candidateId is stable and derived from the order signature + strike', () => {
    const c = makeCandidate({ raw: { signature: '0xdeadbeefdeadbeefdeadbeef' } });
    expect(candidateId(c)).toBe(candidateId(c));
    expect(candidateId(c)).toContain('2300');
  });

  it('toWire carries no raw order and no bigints', () => {
    const w = toWire(makeCandidate({ daysToExpiry: 8.7 }), spec);
    expect((w as any).raw).toBeUndefined();
    expect(w.coverageGapDays).toBeCloseTo(5.3);
    expect(() => JSON.stringify(w)).not.toThrow();
  });

  it('toWire carries the implied strike derived from quantity + total floor', () => {
    const twoEthSpec = { asset: 'ETH' as const, quantity: 2, floorTotalUsd: 4600, horizonDays: 14 };
    const w = toWire(makeCandidate({ strike: 2200 }), twoEthSpec);
    expect(w.impliedStrike).toBe(2300); // 4600 / 2
    expect(w.pctVsImpliedStrike).toBeCloseTo(((2300 - 2200) / 2300) * 100, 5);
    expect(w.pctFromImpliedStrike).toBeCloseTo(((2300 - 2200) / 2300) * 100, 5);
  });

  it('reports a strike ABOVE the implied one as a real distance, not a perfect match', () => {
    const spec1 = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };
    const w = toWire(makeCandidate({ strike: 2990 }), spec1); // 30% above the floor
    expect(w.pctVsImpliedStrike).toBeCloseTo(-30, 5); // negative = above
    expect(w.pctFromImpliedStrike).toBeCloseTo(30, 5); // absolute distance gates the badge
  });

  it('jsonSafe serializes bigints as strings', () => {
    expect(jsonSafe({ a: 5n })).toBe('{"a":"5"}');
  });
});
