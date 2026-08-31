import { describe, it, expect } from 'vitest';
import { rankCandidates } from '../src/core.js';
import { makeCandidate } from './fixtures.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

describe('rankCandidates', () => {
  it('ranks a fully-covering candidate above a short one with a nearer strike', () => {
    const short = makeCandidate({ strike: 2300, daysToExpiry: 11.9, raw: { signature: '0xshort0000000000000' } });
    const covering = makeCandidate({ strike: 2250, daysToExpiry: 16, raw: { signature: '0xcover0000000000000' } });
    const out = rankCandidates([short, covering], spec);
    expect(out[0].daysToExpiry).toBe(16);
  });

  it('still orders by strike distance within the covering partition', () => {
    const far = makeCandidate({ strike: 2100, daysToExpiry: 20, raw: { signature: '0xfar00000000000000' } });
    const near = makeCandidate({ strike: 2290, daysToExpiry: 16, raw: { signature: '0xnear0000000000000' } });
    const out = rankCandidates([far, near], spec);
    expect(out[0].strike).toBe(2290);
  });

  it('treats an exactly-on-deadline candidate as covering', () => {
    const exact = makeCandidate({ strike: 2200, daysToExpiry: 14 });
    const out = rankCandidates([exact], spec);
    expect(out[0].daysToExpiry).toBe(14);
  });

  it('keeps the cheapest short candidate visible even when 8 covering candidates exist', () => {
    const covering = Array.from({ length: 8 }, (_, i) =>
      makeCandidate({
        strike: 2300 - i, daysToExpiry: 16, pricePerContract: 40,
        raw: { signature: `0xcov${i}00000000000000` },
      })
    );
    const cheapShort = makeCandidate({
      strike: 2000, daysToExpiry: 10, pricePerContract: 5,
      raw: { signature: '0xcheap000000000000' },
    });
    const out = rankCandidates([...covering, cheapShort], spec);
    expect(out).toHaveLength(8);
    expect(out.some((c) => c.pricePerContract === 5)).toBe(true);
  });

  it('returns only short candidates when nothing covers the horizon', () => {
    const a = makeCandidate({ strike: 2300, daysToExpiry: 9 });
    const out = rankCandidates([a], spec);
    expect(out).toHaveLength(1);
  });
});
