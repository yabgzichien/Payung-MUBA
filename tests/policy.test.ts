import { describe, it, expect } from 'vitest';
import { decideRoll, validatePolicy, type RollPolicy } from '../src/policy.js';
import { commitmentFor } from '../src/commitments.js';
import type { ShapedPosition } from '../src/positions.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 30 };
const start = new Date('2026-08-30T00:00:00Z');
const commitment = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-05T00:00:00Z', 1, start);

const policy: RollPolicy = {
  rollWhenDaysToExpiry: 2,
  minDeadlineDaysLeft: 1,
  maxPremiumUsd: 25,
  maxRolls: 3,
  assets: ['ETH'],
};

function pos(over: Partial<ShapedPosition> = {}): ShapedPosition {
  return {
    id: '1', optionAddress: '0xopt', underlying: '0xeth', strike: 2300, contracts: 1,
    premiumPaid: 12, collateralAmount: null, collateralSymbol: 'aBasUSDC', pnlUsd: null,
    status: 'active', exercised: null, entryTimestamp: null, entryTxHash: '0xabc',
    entryExplorer: null, expiryTimestamp: null, daysToExpiry: 1.5, ...over,
  } as ShapedPosition;
}

describe('decideRoll', () => {
  it('rolls when expiry is near and the deadline is still ahead', () => {
    const d = decideRoll(pos(), commitment, new Date('2026-09-03T12:00:00Z'), policy);
    expect(d.action).toBe('roll');
  });

  it('does nothing while expiry is still far away', () => {
    const d = decideRoll(pos({ daysToExpiry: 9 }), commitment, new Date('2026-09-01T00:00:00Z'), policy);
    expect(d.action).toBe('none');
  });

  it('fires exactly at the threshold', () => {
    const d = decideRoll(pos({ daysToExpiry: 2 }), commitment, new Date('2026-09-03T00:00:00Z'), policy);
    expect(d.action).toBe('roll');
  });

  it('does nothing once the deadline itself has passed', () => {
    const d = decideRoll(pos(), commitment, new Date('2026-10-01T00:00:00Z'), policy);
    expect(d.action).toBe('none');
  });

  it('does nothing for a position that is not active', () => {
    const d = decideRoll(pos({ status: 'settled-otm' }), commitment, new Date('2026-09-03T12:00:00Z'), policy);
    expect(d.action).toBe('none');
  });

  it('BLOCKS rather than idles when the roll limit is spent', () => {
    const spent = { ...commitment, rollsUsed: 3 };
    const d = decideRoll(pos(), spent, new Date('2026-09-03T12:00:00Z'), policy);
    expect(d.action).toBe('blocked');
    expect(d.reason).toContain('roll limit');
  });

  it('BLOCKS when the asset is outside the policy allowlist', () => {
    const btc = { ...commitment, spec: { ...spec, asset: 'BTC' as const } };
    const d = decideRoll(pos(), btc, new Date('2026-09-03T12:00:00Z'), policy);
    expect(d.action).toBe('blocked');
    expect(d.reason).toContain('BTC');
  });
});

describe('validatePolicy', () => {
  it('accepts a fully specified policy', () => {
    expect(validatePolicy(policy)).toEqual([]);
  });

  it('names every missing field so --auto cannot start half-configured', () => {
    const errs = validatePolicy({ rollWhenDaysToExpiry: 2 } as any);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toContain('maxPremiumUsd');
  });

  it('rejects a non-positive spend cap', () => {
    expect(validatePolicy({ ...policy, maxPremiumUsd: 0 }).join(' ')).toContain('maxPremiumUsd');
  });
});
