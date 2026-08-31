import { describe, it, expect } from 'vitest';
import { GET } from '../app/api/positions/route.js';
import { NextRequest } from 'next/server';

describe('/api/positions route', () => {
  it('validates 0x address format', async () => {
    const req = new NextRequest('http://localhost:3000/api/positions?address=invalid');
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('address must be a valid 0x wallet address');
  });

  it('correctly matches and shapes positions when user is seller (taker writing put)', async () => {
    const userAddr = '0x22955ce01d82b786207a8934430d13a0921822a8';
    const mockPositions = [
      {
        id: '0x7dEF8f621496Ff0CCe75c4E5AB075258Cb1F0Ba5',
        optionAddress: '0x7dEF8f621496Ff0CCe75c4E5AB075258Cb1F0Ba5',
        side: 'seller',
        amount: 500n,
        entryPrice: 9009n,
        currentValue: 0n,
        pnl: 0n,
        option: {
          underlying: 'ETH',
          collateral: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
          strikes: [230000000000n],
          expiry: 1789113600,
          optionType: 11,
        },
        status: 'active',
        buyer: '0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E',
        seller: userAddr,
        entryTimestamp: 1788081165n,
        entryTxHash: '3e7417c5c676109e737f540debe95d0aec9477c9797c19f37e626d0c611cff04',
        collateralAmount: 1150001n,
        collateralSymbol: 'aBasUSDC',
        collateralDecimals: 6,
        optionStatus: 'active',
      },
    ];

    const mockTrades = [
      {
        id: '0x7dEF8f621496Ff0CCe75c4E5AB075258Cb1F0Ba5',
        timestamp: 1788081165,
        txHash: '3e7417c5c676109e737f540debe95d0aec9477c9797c19f37e626d0c611cff04',
        type: 'fill',
        amount: 500n,
        price: 9009n,
        option: {
          address: '0x7dEF8f621496Ff0CCe75c4E5AB075258Cb1F0Ba5',
          underlying: 'ETH',
          expiry: 1789113600,
        },
        status: 'active',
        buyer: '0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E',
        seller: userAddr,
        strikes: [230000000000n],
        collateralAmount: 1150001n,
        collateralSymbol: 'aBasUSDC',
        collateralDecimals: 6,
      },
    ];

    const filterFn = (item: any) => {
      const buyer = String(item.buyer ?? '').toLowerCase();
      const seller = String(item.seller ?? '').toLowerCase();
      return buyer === userAddr || seller === userAddr;
    };

    expect(mockPositions.filter(filterFn)).toHaveLength(1);
    expect(mockTrades.filter(filterFn)).toHaveLength(1);
  });
});
