import { describe, it, expect } from 'vitest';
import { bsPut, impliedVolPut } from '../src/blackscholes.js';

describe('bsPut', () => {
  it('matches the published Hull textbook example (S=42, K=40, T=0.5, r=10%, sigma=20% -> p=0.81)', () => {
    expect(bsPut(42, 40, 0.5, 0.1, 0.2)).toBeCloseTo(0.81, 2);
  });

  it('matches the standard S=K=100, r=5%, sigma=20%, T=1yr reference (p≈5.57)', () => {
    expect(bsPut(100, 100, 1, 0.05, 0.2)).toBeCloseTo(5.57, 1);
  });

  it('approaches discounted intrinsic value as volatility shrinks toward zero', () => {
    const spot = 90;
    const strike = 100;
    const t = 1;
    const r = 0.05;
    const discountedIntrinsic = strike * Math.exp(-r * t) - spot;
    expect(bsPut(spot, strike, t, r, 0.0001)).toBeCloseTo(discountedIntrinsic, 2);
  });

  it('is near zero for a deeply out-of-the-money put', () => {
    expect(bsPut(200, 100, 0.5, 0.05, 0.2)).toBeCloseTo(0, 2);
  });

  it('is never negative', () => {
    expect(bsPut(50, 300, 0.1, 0.05, 0.1)).toBeGreaterThanOrEqual(0);
  });
});

describe('impliedVolPut', () => {
  it('inverts bsPut accurately for known prices', () => {
    const spot = 2400;
    const strike = 2250;
    const t = 57 / 365;
    const r = 0.045;
    const knownIv = 0.35;
    const price = bsPut(spot, strike, t, r, knownIv);
    const solvedIv = impliedVolPut(spot, strike, t, r, price);
    expect(solvedIv).toBeCloseTo(knownIv, 3);
  });

  it('returns null when price is below intrinsic value', () => {
    expect(impliedVolPut(2000, 2200, 0.1, 0.05, 1)).toBeNull();
  });
});

