import { describe, it, expect } from 'vitest';
import { evaluateCommitment } from '../src/watcher.js';
import { commitmentFor } from '../src/commitments.js';
import type { ShapedPosition } from '../src/positions.js';
import type { RollPolicy } from '../src/policy.js';

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

// These stick to decision paths that return before evaluateCommitment would ever
// call findReplacement (which hits the live book) — same no-network-mocking
// convention as the rest of this suite.
describe('evaluateCommitment', () => {
  it('reports no position when nothing in the positions list matches the commitment', async () => {
    const result = await evaluateCommitment(commitment, [], new Date('2026-09-03T12:00:00Z'), policy);
    expect(result.position).toBeNull();
    expect(result.decision).toBeNull();
    expect(result.replacement).toBeNull();
    expect(result.overCap).toBe(false);
  });

  it('matches by entryTxHash and defers to decideRoll — no replacement fetched when nothing needs rolling', async () => {
    const result = await evaluateCommitment(commitment, [pos({ daysToExpiry: 9 })], new Date('2026-09-01T00:00:00Z'), policy);
    expect(result.position).not.toBeNull();
    expect(result.decision?.action).toBe('none');
    expect(result.replacement).toBeNull();
  });

  it('falls back to matching by optionAddress when entryTxHash differs', async () => {
    const result = await evaluateCommitment(
      commitment,
      [pos({ entryTxHash: '0xdifferent', daysToExpiry: 9 })],
      new Date('2026-09-01T00:00:00Z'),
      policy
    );
    expect(result.position).not.toBeNull();
  });

  it('surfaces blocked (roll limit spent) without fetching a replacement', async () => {
    const spent = { ...commitment, rollsUsed: 3 };
    const result = await evaluateCommitment(spent, [pos()], new Date('2026-09-03T12:00:00Z'), policy);
    expect(result.decision?.action).toBe('blocked');
    expect(result.replacement).toBeNull();
    expect(result.overCap).toBe(false);
  });

  it('surfaces blocked (asset outside allowlist) without fetching a replacement', async () => {
    const btc = { ...commitment, spec: { ...spec, asset: 'BTC' as const } };
    const result = await evaluateCommitment(btc, [pos()], new Date('2026-09-03T12:00:00Z'), policy);
    expect(result.decision?.action).toBe('blocked');
    expect(result.replacement).toBeNull();
  });
});
