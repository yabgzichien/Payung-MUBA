import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { capSpend, assertFillable, sumDebits, execute } from '../src/core.js';
import { makeCandidate, ABAS_USDC } from './fixtures.js';

describe('capSpend', () => {
  it('passes through when maker budget suffices', () => {
    expect(capSpend(10, 5000)).toEqual({ spendUsdc: 10, capped: false });
  });
  it('caps to the maker budget and says so', () => {
    expect(capSpend(10, 7.5)).toEqual({ spendUsdc: 7.5, capped: true });
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

describe('execute() paid-amount verification', () => {
  const ME = '0x1111111111111111111111111111111111111111';

  it('throws instead of silently reporting paidUsd=0 when the receipt has no matching Transfer log', async () => {
    const c = makeCandidate({ collateralToken: ABAS_USDC });
    const fakeClient: any = {
      optionBook: {
        callStaticFillOrder: async () => ({}),
        fillOrder: async () => ({ hash: '0xdeadbeef', logs: [] }), // no matching Transfer log
      },
      erc20: {
        ensureAllowance: async () => {},
        getDecimals: async () => 6,
      },
      getSignerAddress: async () => ME,
      chainConfig: { contracts: { optionBook: '0x0000000000000000000000000000000000000b' } },
    };

    await expect(execute(c, 10, fakeClient)).rejects.toThrow(
      /could not determine the amount paid/i
    );
  });
});
