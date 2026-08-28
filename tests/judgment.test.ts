import { describe, it, expect } from 'vitest';
import { judgeQuote } from '../src/judgment.js';
import type { Quote } from '../src/core.js';

function q(over: Partial<Quote> = {}): Quote {
  return {
    requestedUsdc: 10, spendUsdc: 10, capped: false,
    collateralUsdc: 10, numContracts: '1', maxContracts: '100',
    pricePerContract: 19.94, premiumUsdc: 19.94,
    strike: 2300, expiry: new Date('2026-09-10T08:00:00Z'),
    yourSide: 'you buy the option', preview: {},
    ...over,
  };
}

describe('judgeQuote', () => {
  it('calls <5% of floor reasonable', () => {
    const j = judgeQuote(q({ pricePerContract: 19.94, strike: 2300 }), 0); // 0.87%
    expect(j.verdict).toBe('reasonable');
    expect(j.premiumPctOfProtection).toBeCloseTo(0.867, 2);
  });

  it('calls 5-10% expensive', () => {
    const j = judgeQuote(q({ pricePerContract: 161, strike: 2300 }), 0); // 7%
    expect(j.verdict).toBe('expensive');
  });

  it('calls >10% not worth it', () => {
    const j = judgeQuote(q({ pricePerContract: 300, strike: 2300 }), 0); // 13%
    expect(j.verdict).toBe('not-worth-it');
  });

  it('adds a coverage-gap reason when protection ends early', () => {
    const j = judgeQuote(q(), 5.3);
    expect(j.reasons.some((r) => /5\.3 days BEFORE/.test(r))).toBe(true);
  });

  it('has no coverage reason when the horizon is covered', () => {
    const j = judgeQuote(q(), 0);
    expect(j.reasons.some((r) => /BEFORE/.test(r))).toBe(false);
  });
});
