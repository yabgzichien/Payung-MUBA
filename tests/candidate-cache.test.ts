import { beforeEach, describe, expect, it } from 'vitest';
import { cache, CACHE_MAX_AGE_MS, getCached, rememberCandidates } from '../src/api-shared';
import type { Candidate, ProtectionSpec } from '../src/core';

const spec = { asset: 'ETH', quantity: 1, floorTotalUsd: 2200, horizonDays: 14 } as ProtectionSpec;

function candidate(strike: number): Candidate {
  return { strike, takerIsBuyer: true } as unknown as Candidate;
}

function remember(ids: string[], now?: number) {
  rememberCandidates(
    ids.map((id) => ({ id, candidate: candidate(2000), spec })),
    now
  );
}

describe('candidate cache', () => {
  beforeEach(() => cache.clear());

  /**
   * The bug this exists for: /api/candidates used to call cache.clear() on
   * every request, so a second search — another browser tab, another user, or
   * the Explore screen re-pricing a floor — evicted the candidate the first
   * search was still holding, and that user's /api/quote and /api/prepare-tx
   * failed mid-purchase with "Unknown or stale candidate id".
   */
  it('keeps an earlier search alive when a later, disjoint search arrives', () => {
    remember(['eth-2150', 'eth-2300']);
    remember(['btc-76000', 'btc-75000']);

    expect(getCached('eth-2150').candidate.strike).toBe(2000);
    expect(getCached('btc-76000').candidate.strike).toBe(2000);
    expect(cache.size).toBe(4);
  });

  it('still refuses a candidate older than the max age', () => {
    remember(['stale'], Date.now() - CACHE_MAX_AGE_MS - 1);
    expect(() => getCached('stale')).toThrow(/too long ago/i);
  });

  it('sweeps expired entries when a new search is recorded', () => {
    remember(['old'], Date.now() - CACHE_MAX_AGE_MS - 1);
    remember(['fresh']);
    expect(cache.has('old')).toBe(false);
    expect(cache.has('fresh')).toBe(true);
  });

  it('refreshes the clock on a candidate that is searched again', () => {
    const old = Date.now() - CACHE_MAX_AGE_MS + 1000;
    remember(['repeat'], old);
    remember(['repeat']);
    expect(() => getCached('repeat')).not.toThrow();
  });

  it('bounds growth so an append-only cache cannot leak', () => {
    for (let batch = 0; batch < 12; batch += 1) {
      remember(Array.from({ length: 60 }, (_, i) => `c-${batch}-${i}`));
    }
    expect(cache.size).toBeLessThanOrEqual(500);
    // The most recent search always survives the trim.
    expect(cache.has('c-11-59')).toBe(true);
  });

  it('throws a client error for an id that was never cached', () => {
    expect(() => getCached('never-seen')).toThrow(/unknown or stale/i);
  });
});
