import { describe, it, expect } from 'vitest';
import { filterCandidates, type FilterConfig } from '../src/core.js';
import { makeCandidate, USDC, ABAS_USDC, WETH, FEED_ETH, FEED_BTC } from './fixtures.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };
const cfg: FilterConfig = { dollarTokens: new Set([USDC, ABAS_USDC]), assetPriceFeed: FEED_ETH };

describe('filterCandidates', () => {
  it('accepts aBasUSDC-collateralized buyable puts (Audit Attack 1)', () => {
    const book = [makeCandidate({ collateralToken: ABAS_USDC })];
    expect(filterCandidates(book, spec, cfg)).toHaveLength(1);
  });

  it('accepts raw-USDC collateral too', () => {
    const book = [makeCandidate({ collateralToken: USDC })];
    expect(filterCandidates(book, spec, cfg)).toHaveLength(1);
  });

  it('rejects non-dollar collateral (WETH)', () => {
    const book = [makeCandidate({ collateralToken: WETH })];
    expect(filterCandidates(book, spec, cfg)).toHaveLength(0);
  });

  it('rejects a different underlying even at a nearby strike (Audit Attack 2)', () => {
    const book = [makeCandidate({ priceFeed: FEED_BTC, strike: 2200 })];
    expect(filterCandidates(book, spec, cfg)).toHaveLength(0);
  });

  it('rejects calls and write-the-put orders', () => {
    const book = [
      makeCandidate({ isCall: true }),
      // takerIsBuyer:false means WE would be writing the put and posting
      // contracts x strike as collateral. Never a protection purchase.
      makeCandidate({ takerIsBuyer: false, yourSide: 'you sell the option' }),
    ];
    expect(filterCandidates(book, spec, cfg)).toHaveLength(0);
  });

  it('keeps ONLY the side where the taker buys (regression: filter was inverted)', () => {
    const book = [
      makeCandidate({ takerIsBuyer: true, yourSide: 'you buy the option' }),
      makeCandidate({ takerIsBuyer: false, yourSide: 'you sell the option' }),
    ];
    const out = filterCandidates(book, spec, cfg);
    expect(out).toHaveLength(1);
    expect(out[0].takerIsBuyer).toBe(true);
    expect(out[0].yourSide).toBe('you buy the option');
  });

  it('keeps the 0.6x-2.5x horizon window and ranks by strike distance', () => {
    const book = [
      makeCandidate({ strike: 2100, daysToExpiry: 10 }),
      makeCandidate({ strike: 2290, daysToExpiry: 10 }),
      makeCandidate({ strike: 2290, daysToExpiry: 5 }),  // 5 < 14*0.6 -> out
      makeCandidate({ strike: 2290, daysToExpiry: 40 }), // 40 > 14*2.5 -> out
    ];
    const out = filterCandidates(book, spec, cfg);
    expect(out).toHaveLength(2);
    expect(out[0].strike).toBe(2290); // closest to 2300 first
  });

  it('ranks by impliedStrike (floorTotalUsd / quantity), not the raw total', () => {
    // 2 ETH at a $4600 total floor implies a $2300/ETH strike — the same
    // ranking as the 1-ETH/$2300 spec above, even though floorTotalUsd differs.
    const twoEthSpec = { asset: 'ETH' as const, quantity: 2, floorTotalUsd: 4600, horizonDays: 14 };
    const book = [
      makeCandidate({ strike: 2100, daysToExpiry: 10 }),
      makeCandidate({ strike: 2290, daysToExpiry: 10 }),
    ];
    const out = filterCandidates(book, twoEthSpec, cfg);
    expect(out[0].strike).toBe(2290); // closest to implied 2300, not to raw 4600
  });

  it('returns at most 8 candidates', () => {
    const book = Array.from({ length: 12 }, (_, i) => makeCandidate({ strike: 2000 + i * 10 }));
    expect(filterCandidates(book, spec, cfg)).toHaveLength(8);
  });
});
