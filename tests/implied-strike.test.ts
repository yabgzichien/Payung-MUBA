import { describe, it, expect } from 'vitest';
import { impliedStrike, type ProtectionSpec } from '../src/spec.js';

describe('impliedStrike', () => {
  it('divides total floor by quantity to get a per-unit strike', () => {
    const spec: ProtectionSpec = { asset: 'ETH', quantity: 0.32, floorTotalUsd: 798, horizonDays: 14 };
    expect(impliedStrike(spec)).toBeCloseTo(2493.75, 2);
  });

  it('is exactly the floor when quantity is 1', () => {
    const spec: ProtectionSpec = { asset: 'ETH', quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };
    expect(impliedStrike(spec)).toBe(2300);
  });

  it('produces a large implied strike for a small quantity (the $798-for-0.32-ETH regression case)', () => {
    const spec: ProtectionSpec = { asset: 'ETH', quantity: 0.01, floorTotalUsd: 798, horizonDays: 14 };
    expect(impliedStrike(spec)).toBeCloseTo(79800, 0);
  });
});
