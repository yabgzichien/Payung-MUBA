import { describe, it, expect } from 'vitest';
import { quote, payoffCurve, type Quote } from '../src/core.js';
import { makeCandidate, ABAS_USDC } from './fixtures.js';

/**
 * Regression tests for the "collateral ≈ strike × contracts" bug: the SDK's
 * `previewFillOrder.totalCollateral` is just an echo of the usdcAmount you
 * pass in, never strike-scaled. This fake mirrors the real SDK's
 * calculateNumContracts/previewFillOrder formulas closely enough to catch a
 * reversion to the old (wrong) identity.
 */
function fakePreview(usdcAmount: bigint, priceRaw: bigint, maxContracts: bigint) {
  const naive = (usdcAmount * 100_000_000n) / priceRaw;
  const numContracts = naive > maxContracts ? maxContracts : naive;
  return {
    numContracts,
    maxContracts,
    totalCollateral: usdcAmount, // SDK quirk: echoes the input verbatim
    pricePerContract: priceRaw,
  };
}

function fakeClient(maxContracts = 5_000_000n, priceRaw = 1_994_000_000n) {
  return {
    optionBook: {
      getPriceDecimals: async () => 100_000_000n,
      previewFillOrder: (_raw: any, usdcAmount: bigint) => fakePreview(usdcAmount, priceRaw, maxContracts),
    },
  } as any;
}

describe('quote() contract math', () => {
  const candidate = makeCandidate({
    strike: 2300,
    pricePerContract: 19.94,
    makerBudget: 5000,
    collateralToken: ABAS_USDC,
  });

  it('derives contracts from preview.numContracts (6-decimal scale), not collateral/strike', async () => {
    const q = await quote(candidate, 10, fakeClient());
    // 10 / 19.94 contracts (~0.5015), NOT 10 / 2300 (~0.00435 — the old bug)
    expect(q.contracts).toBeCloseTo(10 / 19.94, 3);
  });

  it('reports a premium close to what was actually spent, not off by ~strike/price', async () => {
    const q = await quote(candidate, 10, fakeClient());
    expect(q.premiumUsdc).toBeCloseTo(10, 1);
  });

  it('does not mistake totalCollateral (an echo of the input) for a strike-scaled figure', async () => {
    const q = await quote(candidate, 10, fakeClient());
    expect(q.collateralUsdc).toBeCloseTo(10, 6);
  });
});

describe('payoffCurve uses the real contract count', () => {
  it('scales intrinsic value by q.contracts, not collateralUsdc / strike', () => {
    const q: Quote = {
      requestedUsdc: 10, spendUsdc: 10, capped: false,
      collateralUsdc: 10, numContracts: '501504', maxContracts: '5000000',
      pricePerContract: 19.94, premiumUsdc: 10,
      contracts: 0.501504,
      strike: 2300, expiry: new Date(), yourSide: 'you buy the option', preview: {},
    };
    const curve = payoffCurve(q, [2000, 2000], 1);
    const expectedIntrinsic = (2300 - 2000) * 0.501504;
    expect(curve[0].pnl).toBeCloseTo(expectedIntrinsic - q.premiumUsdc, 2);
  });
});
