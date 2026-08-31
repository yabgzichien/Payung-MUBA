import { describe, it, expect } from 'vitest';
import { coverageChoice } from '../src/core.js';
import { makeCandidate } from './fixtures.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

describe('coverageChoice', () => {
  it('names the premium delta between full coverage and the cheaper partial', () => {
    const covering = makeCandidate({ strike: 2300, daysToExpiry: 16, pricePerContract: 20 });
    const short = makeCandidate({ strike: 2300, daysToExpiry: 12, pricePerContract: 17.45 });
    const c = coverageChoice([covering, short], spec);
    expect(c.best?.daysToExpiry).toBe(16);
    expect(c.cheaperShort?.pricePerContract).toBe(17.45);
    expect(c.premiumDelta).toBeCloseTo(2.55, 2);
    expect(c.gapDays).toBeCloseTo(2, 5);
    expect(c.surplusDays).toBeCloseTo(2, 5);
  });

  it('reports a negative delta when full coverage is actually cheaper', () => {
    const covering = makeCandidate({ strike: 2300, daysToExpiry: 16, pricePerContract: 10 });
    const short = makeCandidate({ strike: 2300, daysToExpiry: 12, pricePerContract: 17 });
    const c = coverageChoice([covering, short], spec);
    expect(c.premiumDelta).toBeCloseTo(-7, 5);
  });

  it('returns nulls for the missing side when a partition is empty', () => {
    const onlyShort = makeCandidate({ daysToExpiry: 10 });
    const c = coverageChoice([onlyShort], spec);
    expect(c.best).toBeNull();
    expect(c.premiumDelta).toBeNull();
    expect(c.cheaperShort?.daysToExpiry).toBe(10);
  });

  it('returns all nulls for an empty list', () => {
    const c = coverageChoice([], spec);
    expect(c.best).toBeNull();
    expect(c.cheaperShort).toBeNull();
    expect(c.premiumDelta).toBeNull();
    expect(c.gapDays).toBeNull();
    expect(c.surplusDays).toBeNull();
  });
});
