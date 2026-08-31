import { describe, it, expect } from 'vitest';
import { commitmentFor, deadlineDaysLeft } from '../src/commitments.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

describe('commitmentFor', () => {
  it('resolves the relative horizon to an absolute date at write time', () => {
    const now = new Date('2026-08-30T00:00:00Z');
    const c = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-08T08:00:00Z', 1, now);
    expect(c.deadlineIso).toBe('2026-09-13T00:00:00.000Z');
    expect(c.rollsUsed).toBe(0);
  });
});

describe('deadlineDaysLeft', () => {
  it('counts down from the absolute deadline, not the original horizon', () => {
    const now = new Date('2026-08-30T00:00:00Z');
    const c = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-08T08:00:00Z', 1, now);
    expect(deadlineDaysLeft(c, new Date('2026-09-06T00:00:00Z'))).toBeCloseTo(7, 5);
  });

  it('goes negative once the deadline has passed', () => {
    const now = new Date('2026-08-30T00:00:00Z');
    const c = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-08T08:00:00Z', 1, now);
    expect(deadlineDaysLeft(c, new Date('2026-09-15T00:00:00Z'))).toBeLessThan(0);
  });
});
