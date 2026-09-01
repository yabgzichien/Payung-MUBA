import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { commitmentFor, writeCommitment, readCommitments, incrementRolls } from '../src/commitments.js';

const DIR = '.payung-test';
const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe('incrementRolls', () => {
  it('advances the counter the policy cap is checked against', () => {
    const c = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-08T00:00:00Z', 1, new Date('2026-08-30T00:00:00Z'));
    writeCommitment(c, DIR);
    incrementRolls('0xabc', DIR);
    incrementRolls('0xabc', DIR);
    expect(readCommitments(DIR)[0].rollsUsed).toBe(2);
  });

  it('is a no-op for an unknown hash', () => {
    const c = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-08T00:00:00Z', 1, new Date('2026-08-30T00:00:00Z'));
    writeCommitment(c, DIR);
    incrementRolls('0xnope', DIR);
    expect(readCommitments(DIR)[0].rollsUsed).toBe(0);
  });
});
