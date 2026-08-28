import { describe, it, expect } from 'vitest';
import { coverageGapDays } from '../src/core.js';
import { makeCandidate } from './fixtures.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

describe('coverageGapDays', () => {
  it('is zero when the option outlives the horizon', () => {
    expect(coverageGapDays(makeCandidate({ daysToExpiry: 21 }), spec)).toBe(0);
  });
  it('is the shortfall when the option ends early', () => {
    expect(coverageGapDays(makeCandidate({ daysToExpiry: 8.7 }), spec)).toBeCloseTo(5.3);
  });
});
