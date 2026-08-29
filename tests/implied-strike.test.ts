import { describe, it, expect } from 'vitest';
import { impliedStrike, totalFromUnit, type ProtectionSpec } from '../src/spec.js';

describe('totalFromUnit', () => {
  it('multiplies a per-unit floor price by quantity to get the total floor', () => {
    expect(totalFromUnit(62000, 0.4)).toBeCloseTo(24800, 6);
  });

  it('is exactly the unit price when quantity is 1', () => {
    expect(totalFromUnit(2300, 1)).toBe(2300);
  });

  it('inverts impliedStrike (unit -> total -> unit round-trips)', () => {
    const spec: ProtectionSpec = { asset: 'ETH', quantity: 0.32, floorTotalUsd: 798, horizonDays: 14 };
    const unit = impliedStrike(spec);
    expect(totalFromUnit(unit, spec.quantity)).toBeCloseTo(spec.floorTotalUsd, 6);
  });
});

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
