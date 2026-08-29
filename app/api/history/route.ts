import type { NextRequest } from 'next/server';
import { readClient } from '@/src/core';
import { fetchHistory, fetchSpot, type Candle } from '@/src/spot';
import {
  candleCache, HISTORY_CACHE_MS, jsonResponse, spotCache, withErrorHandling, type SpotReading,
} from '@/src/api-shared';

export async function GET(req: NextRequest) {
  return withErrorHandling(async () => {
    const params = req.nextUrl.searchParams;
    const asset = params.get('asset');
    if (asset !== 'ETH' && asset !== 'BTC') {
      return jsonResponse(400, { error: 'asset must be ETH or BTC' });
    }
    const days = Math.min(90, Math.max(1, Number(params.get('days') ?? 14)));
    const now = Date.now();

    // Spot is cached per ASSET (it does not vary with the history window), so
    // one good read serves every day-count for the next 60s. Candles are cached
    // per asset+days. Each is stored only on its own success, so a spot failure
    // can no longer throw away a perfectly good candle fetch — and vice versa.
    const client = readClient();
    let spot: SpotReading | null = null;
    let spotError: string | null = null;
    const cachedSpot = spotCache.get(asset);
    if (cachedSpot && now - cachedSpot.fetchedAt < HISTORY_CACHE_MS) {
      spot = cachedSpot.spot;
    } else {
      try {
        const feed = client.chainConfig.priceFeeds[asset];
        if (!feed) throw new Error(`No price feed configured for ${asset}`);
        // client.provider and client.chainConfig are public typed fields on
        // ThetanutsClient — no cast needed. Reading them here (rather than
        // inside spot.ts) is what keeps spot.ts free of the SDK.
        spot = await fetchSpot(feed, client.provider);
        spotCache.set(asset, { spot, fetchedAt: Date.now() });
      } catch (e: any) {
        spotError = e?.shortMessage || e?.message || String(e);
        console.error('fetchSpot failed:', spotError);
      }
    }

    let candles: Candle[] = [];
    let historySource: 'coinbase-exchange' | null = null;
    let historyError: string | null = null;
    const candleKey = `${asset}:${days}`;
    const cachedCandles = candleCache.get(candleKey);
    if (cachedCandles && now - cachedCandles.fetchedAt < HISTORY_CACHE_MS) {
      candles = cachedCandles.candles;
      historySource = 'coinbase-exchange';
    } else {
      try {
        candles = await fetchHistory(asset, days);
        historySource = 'coinbase-exchange';
        candleCache.set(candleKey, { candles, fetchedAt: Date.now() });
      } catch (e: any) {
        historyError = e?.message || String(e);
        console.error('fetchHistory failed:', historyError);
      }
    }

    return jsonResponse(200, {
      candles,
      spot: spot ? { ...spot, source: 'chainlink' as const } : null,
      historySource,
      // Surfaced, not just logged: a chart that silently drops its headline
      // number looks identical to one that never had it. The UI shows these
      // (Task 9) so a degraded chart is legibly degraded, never mistaken for
      // complete. Never a fabricated fallback price.
      spotError,
      historyError,
    });
  });
}
