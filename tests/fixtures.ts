import type { Candidate } from '../src/core.js';

// Fake but valid-shaped addresses. Tests never touch the network.
export const FEED_ETH = '0x00000000000000000000000000000000000000e1';
export const FEED_BTC = '0x00000000000000000000000000000000000000b1';
export const USDC = '0x00000000000000000000000000000000000000c1';
export const ABAS_USDC = '0x00000000000000000000000000000000000000a1';
export const WETH = '0x00000000000000000000000000000000000000f1';

export function makeCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    raw: { signature: '0xs1gdefault0000000000' },
    isCall: false,
    // takerIsBuyer: true is the buy-protection side (taker owes only the
    // premium). See the field docs in src/core.ts.
    takerIsBuyer: true,
    yourSide: 'you buy the option',
    strike: 2300,
    expiry: new Date('2026-09-10T08:00:00Z'),
    daysToExpiry: 14,
    pricePerContract: 19.94,
    collateralToken: ABAS_USDC,
    priceFeed: FEED_ETH,
    makerBudget: 5000,
    greeks: { iv: 0.55 },
    ...over,
  };
}
