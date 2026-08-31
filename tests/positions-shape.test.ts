import { describe, it, expect } from 'vitest';
import { normalizeHash, shapeProtection } from '../src/positions.js';

describe('normalizeHash', () => {
  it('adds the 0x prefix the indexer omits', () => {
    const bare = 'a'.repeat(64);
    expect(normalizeHash(bare)).toBe(`0x${bare}`);
  });

  it('lowercases and preserves an already-prefixed hash', () => {
    const h = `0x${'A'.repeat(64)}`;
    expect(normalizeHash(h)).toBe(`0x${'a'.repeat(64)}`);
  });

  it('rejects a wrong-length or empty value', () => {
    expect(normalizeHash('0xdeadbeef')).toBeNull();
    expect(normalizeHash('')).toBeNull();
    expect(normalizeHash(null)).toBeNull();
  });
});

describe('shapeProtection', () => {
  it('scales strike by 1e8 and premium by collateral decimals', () => {
    const s = shapeProtection({
      id: '1',
      optionAddress: '0xopt',
      option: { strikes: ['230000000000'], expiry: 1_790_000_000, underlying: '0xeth' },
      amount: '1000000',
      entryPrice: '12081192',
      collateralDecimals: 6,
      optionStatus: 'active',
    }, 1_789_000_000);
    expect(s.strike).toBe(2300);
    expect(s.premiumPaid).toBeCloseTo(12.081192, 6);
    expect(s.contracts).toBe(1);
    expect(s.status).toBe('active');
  });

  it('computes days to expiry from the passed clock, not wall time', () => {
    const s = shapeProtection(
      { id: '2', option: { strikes: ['230000000000'], expiry: 1_789_086_400 }, optionStatus: 'active' },
      1_789_000_000
    );
    expect(s.daysToExpiry).toBeCloseTo(1, 1);
  });
});

import { STRIKE_DECIMALS, USDC_DECIMALS } from '../src/core.js';

describe('decimal constants stay in sync with core.ts', () => {
  it('matches the values positions.ts redeclares', () => {
    expect(STRIKE_DECIMALS).toBe(8);
    expect(USDC_DECIMALS).toBe(6);
  });
});
