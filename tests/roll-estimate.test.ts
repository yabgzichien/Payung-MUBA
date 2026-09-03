import { describe, it, expect } from 'vitest';
import { estimateRoll, type ProtectionSpec } from '../src/core.js';
import { bsPut } from '../src/blackscholes.js';
import { makeCandidate } from './fixtures.js';

const spec: ProtectionSpec = { asset: 'ETH', quantity: 1, floorTotalUsd: 2225, horizonDays: 14 };

describe('estimateRoll', () => {
  it('returns null when no candidate falls short of the horizon', () => {
    const covering = makeCandidate({ strike: 2200, daysToExpiry: 20, greeks: { iv: 0.5 } });
    expect(estimateRoll([covering], spec, 2300)).toBeNull();
  });

  it('returns null when the only short-dated candidates report no IV and have no price to solve from', () => {
    const short = makeCandidate({ strike: 2200, daysToExpiry: 3, pricePerContract: 0, greeks: {} });
    expect(estimateRoll([short], spec, 2300)).toBeNull();
  });

  it('solves IV from market price when greeks.iv is not provided', () => {
    const short = makeCandidate({ strike: 2200, daysToExpiry: 3, pricePerContract: 8, greeks: {} });
    const est = estimateRoll([short], spec, 2300);
    expect(est).not.toBeNull();
    expect(est?.ivUsed).toBeGreaterThan(0);
  });

  it('anchors on the nearest-to-target strike among short-dated, IV-bearing candidates', () => {
    const far = makeCandidate({ strike: 2000, daysToExpiry: 2, pricePerContract: 5, greeks: { iv: 0.5 } });
    const near = makeCandidate({ strike: 2220, daysToExpiry: 3, pricePerContract: 8, greeks: { iv: 0.55 } });
    const est = estimateRoll([far, near], spec, 2300);
    expect(est?.anchorLeg.strike).toBe(2220);
    expect(est?.ivUsed).toBe(0.55);
    expect(est?.spotUsed).toBe(2300);
  });

  it('anchorPremiumUsd is the real live premium scaled by quantity', () => {
    const anchor = makeCandidate({ strike: 2220, daysToExpiry: 3, pricePerContract: 8, greeks: { iv: 0.55 } });
    const twoUnitSpec: ProtectionSpec = { ...spec, quantity: 2 };
    const est = estimateRoll([anchor], twoUnitSpec, 2300);
    expect(est?.anchorPremiumUsd).toBeCloseTo(16, 6);
  });

  it('estimatedLegs rounds up to the nearest whole roll', () => {
    const anchor = makeCandidate({ strike: 2220, daysToExpiry: 3, greeks: { iv: 0.55 } });
    const est = estimateRoll([anchor], spec, 2300); // horizonDays=14, daysToExpiry=3 -> ceil(14/3)=5
    expect(est?.estimatedLegs).toBe(5);
  });

  it('estimatedTotalPremiumUsd is the BS put price at the exact target strike/horizon, scaled by quantity', () => {
    const anchor = makeCandidate({ strike: 2220, daysToExpiry: 3, greeks: { iv: 0.55 } });
    const threeUnitSpec: ProtectionSpec = { asset: 'ETH', quantity: 3, floorTotalUsd: 6675, horizonDays: 14 }; // implied strike 2225
    const est = estimateRoll([anchor], threeUnitSpec, 2300);
    const expected = bsPut(2300, 2225, 14 / 365, 0.045, 0.55) * 3;
    expect(est?.estimatedTotalPremiumUsd).toBeCloseTo(expected, 6);
  });
});
