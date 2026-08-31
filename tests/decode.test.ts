import { describe, it, expect } from 'vitest';
import { decodeOrder } from '../src/core.js';
import { ABAS_USDC, FEED_ETH } from './fixtures.js';

const NOW = 1_788_000_000; // fixed "now" in unix seconds

function rawOrder(over: any = {}) {
  return {
    order: {
      expiry: String(NOW + 14 * 86400),
      // isBuyer:true is the side where the TAKER buys (owes premium only).
      isBuyer: true,
      strikePrice: '230000000000', // 1e8 scale -> $2300
      price: '1994000000',         // scale 1e8 -> $19.94
      collateralToken: ABAS_USDC,
      ...over.order,
    },
    availableAmount: 5_000_000_000n, // 5000 with 6 decimals
    signature: '0xabc',
    rawApiData: { isCall: false, priceFeed: FEED_ETH.toUpperCase(), greeks: { iv: 0.55 } },
    ...over,
  };
}

describe('decodeOrder', () => {
  it('decodes strike, price, expiry, side and budget', () => {
    const c = decodeOrder(rawOrder(), 1e8, NOW, 6);
    expect(c.strike).toBe(2300);
    expect(c.pricePerContract).toBeCloseTo(19.94);
    expect(c.daysToExpiry).toBeCloseTo(14);
    expect(c.takerIsBuyer).toBe(true);
    expect(c.yourSide).toBe('you buy the option');
    expect(c.makerBudget).toBe(5000);
  });

  it('uses the collateral token own decimals for maker budget (18-dec token)', () => {
    const o = rawOrder({ availableAmount: 2_000_000_000_000_000_000n }); // 2.0 with 18 decimals
    const c = decodeOrder(o, 1e8, NOW, 18);
    expect(c.makerBudget).toBe(2);
  });

  it('lowercases the price feed', () => {
    const c = decodeOrder(rawOrder(), 1e8, NOW, 6);
    expect(c.priceFeed).toBe(FEED_ETH); // fixture is already lowercase
  });

  it('marks isBuyer:false orders as you-sell (taker would write the put)', () => {
    const c = decodeOrder(rawOrder({ order: { isBuyer: false } }), 1e8, NOW, 6);
    expect(c.yourSide).toBe('you sell the option');
  });
});
