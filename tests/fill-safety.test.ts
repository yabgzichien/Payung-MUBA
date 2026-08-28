import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { capSpend, assertFillable, sumDebits, execute, simulate } from '../src/core.js';
import { makeCandidate, ABAS_USDC } from './fixtures.js';

describe('capSpend', () => {
  // The real ceiling is maxContracts × price, where maxContracts = makerBudget
  // / strike (SDK's own cash-secured-put rule) — NOT makerBudget itself.
  // makerBudget is collateral dollars; the premium ceiling is much smaller.
  it('passes through when maker budget suffices', () => {
    expect(capSpend(10, 5000, 2300, 19.94)).toEqual({ spendUsdc: 10, capped: false });
  });
  it('caps to maxContracts × price, not the raw collateral budget', () => {
    // makerBudget 50 at strike 2300 => maxContracts ≈ 0.02174 => max premium ≈ $0.4335
    const res = capSpend(10, 50, 2300, 19.94);
    expect(res.capped).toBe(true);
    expect(res.spendUsdc).toBeCloseTo((50 / 2300) * 19.94, 6);
  });
});

describe('assertFillable', () => {
  const c = makeCandidate({ expiry: new Date('2026-09-10T08:00:00Z') });
  const expirySec = Math.floor(c.expiry.getTime() / 1000);
  it('accepts an order with time left', () => {
    expect(() => assertFillable(c, expirySec - 3600)).not.toThrow();
  });
  it('rejects an order inside the buffer, telling the user to re-quote', () => {
    expect(() => assertFillable(c, expirySec - 30)).toThrow(/re-quote/i);
  });

  it('also rejects on the MAKER ORDER expiry, which can be far sooner than the option expiry', () => {
    // The option itself is weeks out (passed the horizon filter), but the
    // maker's signed order — a distinct, typically much shorter-lived
    // expiry — is about to lapse. Checking option expiry alone misses this.
    const orderExpirySec = Math.floor(Date.parse('2026-08-01T00:00:00Z') / 1000);
    const withOrderExpiry = makeCandidate({
      expiry: new Date('2026-09-10T08:00:00Z'),
      raw: { signature: '0xs1g', rawApiData: { orderExpiryTimestamp: orderExpirySec } },
    });
    expect(() => assertFillable(withOrderExpiry, orderExpirySec - 30)).toThrow(/re-quote/i);
    expect(() => assertFillable(withOrderExpiry, orderExpirySec - 3600)).not.toThrow();
  });
});

describe('sumDebits', () => {
  const ME = '0x1111111111111111111111111111111111111111';
  const OTHER = '0x2222222222222222222222222222222222222222';
  const TRANSFER = ethers.id('Transfer(address,address,uint256)');
  const pad = (a: string) => ethers.zeroPadValue(a, 32);
  const log = (token: string, from: string, amount: bigint) => ({
    address: token,
    topics: [TRANSFER, pad(from), pad(OTHER)],
    data: ethers.toBeHex(amount, 32),
  });

  it('sums transfers out of my address on the collateral token only', () => {
    const logs = [
      log(ABAS_USDC, ME, 7_000_000n),
      log(ABAS_USDC, ME, 3_000_000n),
      log(ABAS_USDC, OTHER, 99_000_000n),          // not from me
      log('0x00000000000000000000000000000000000000f1', ME, 5n), // wrong token
    ];
    expect(sumDebits(logs, ABAS_USDC, ME)).toBe(10_000_000n);
  });
});

describe('simulate()', () => {
  const c = makeCandidate({ collateralToken: ABAS_USDC });

  it('reports ok:true only when the SDK resolves success:true', async () => {
    const client = { optionBook: { callStaticFillOrder: async () => ({ success: true }) } } as any;
    expect(await simulate(c, 10, client)).toMatchObject({ ok: true });
  });

  it('reports ok:false when the SDK resolves success:false — it does NOT throw on a would-revert fill', async () => {
    const client = {
      optionBook: { callStaticFillOrder: async () => ({ success: false, error: { message: 'would revert' } }) },
    } as any;
    const res = await simulate(c, 10, client);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/would revert/);
  });

  it('still reports ok:false for a genuinely rejected promise', async () => {
    const client = {
      optionBook: { callStaticFillOrder: async () => { throw new Error('rpc down'); } },
    } as any;
    const res = await simulate(c, 10, client);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/rpc down/);
  });
});

describe('execute() paid-amount verification', () => {
  const ME = '0x1111111111111111111111111111111111111111';

  function fakeClient(overrides: Partial<{ callStaticFillOrder: () => Promise<any> }> = {}) {
    return {
      optionBook: {
        callStaticFillOrder: overrides.callStaticFillOrder ?? (async () => ({ success: true })),
        fillOrder: async () => ({ hash: '0xdeadbeef', logs: [] }), // no matching Transfer log
      },
      erc20: {
        ensureAllowance: async () => {},
        getDecimals: async () => 6,
      },
      getSignerAddress: async () => ME,
      getContractAddress: () => '0x0000000000000000000000000000000000000b',
    } as any;
  }

  it('never throws once fillOrder() has landed — reports paidUsd: null instead when the receipt has no matching Transfer log', async () => {
    // CRITICAL: fillOrder() already succeeded here. Throwing would tell the
    // caller the fill failed when a real on-chain transaction just landed —
    // that's how a demo invites a duplicate real-money click. The correct
    // behavior is to report the fill as successful with an unknown paid amount.
    const c = makeCandidate({ collateralToken: ABAS_USDC });
    const res = await execute(c, 10, fakeClient());
    expect(res.hash).toBe('0xdeadbeef');
    expect(res.paidUnits).toBe(0n);
    expect(res.paidUsd).toBeNull();
  });

  it('refuses to send when callStaticFillOrder resolves success:false (the SDK never throws on a would-revert fill)', async () => {
    // The regression test for the "simulate() reports ok:true unconditionally"
    // bug: the SDK resolves { success: false, error } on a would-revert fill
    // rather than rejecting the promise. execute() must read that field.
    const c = makeCandidate({ collateralToken: ABAS_USDC });
    const client = fakeClient({
      callStaticFillOrder: async () => ({ success: false, error: { message: 'insufficient collateral' } }),
    });
    await expect(execute(c, 10, client)).rejects.toThrow(/simulation failed/i);
  });
});
