import type { NextRequest } from 'next/server';
import { ethers } from 'ethers';
import { readClient, STRIKE_DECIMALS, USDC_DECIMALS } from '@/src/core';
import { jsonResponse, withErrorHandling } from '@/src/api-shared';
import { shapeProtection } from '@/src/positions';

/**
 * The indexer returns tx hashes WITHOUT the 0x prefix (verified against 5817
 * live records: 0 prefixed, 5817 bare). Pasting a bare hash into a BaseScan
 * URL yields a broken link, so normalize here — the one place that builds
 * both the link and the displayed hash.
 */
function normalizeHash(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const hex = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return `0x${hex.toLowerCase()}`;
}

const BASESCAN_TX = (hash: string) => `https://basescan.org/tx/${hash}`;

function toNum(v: unknown, scale = 1): number | null {
  if (v === undefined || v === null) return null;
  return Number(v) / scale;
}

/** One trade-log entry (fill/exercise/settle/close), decoded for the UI. */
function shapeTrade(h: any) {
  const strikeRaw = Array.isArray(h.strikes) && h.strikes.length > 0
    ? h.strikes[0]
    : Array.isArray(h.option?.strikes) && h.option.strikes.length > 0
    ? h.option.strikes[0]
    : undefined;
  const dec = Number(h.collateralDecimals ?? USDC_DECIMALS);
  const txHash = normalizeHash(h.txHash ?? h.entryTxHash);
  return {
    // The indexer keys history rows by option address, so the same option can
    // appear more than once (fill, then settle). Compose with type+timestamp
    // so React keys stay unique even then.
    id: `${h.id}-${h.type}-${h.timestamp ?? 0}`,
    type: h.type,
    timestamp: h.timestamp ?? null,
    timestampIso: h.timestamp ? new Date(Number(h.timestamp) * 1000).toISOString() : null,
    txHash,
    explorer: txHash ? BASESCAN_TX(txHash) : null,
    underlying: h.option?.underlying ?? h.underlyingAsset ?? null,
    strike: toNum(strikeRaw, 10 ** STRIKE_DECIMALS),
    expiryIso: h.option?.expiry
      ? new Date(Number(h.option.expiry) * 1000).toISOString()
      : h.expiryTimestamp
      ? new Date(Number(h.expiryTimestamp) * 1000).toISOString()
      : null,
    amount: toNum(h.amount ?? h.numContracts, 10 ** USDC_DECIMALS),
    /** Same premiumAmount semantics as shapeProtection.premiumPaid — total, in collateral units. */
    premiumPaid: toNum(h.price ?? h.entryPremium, 10 ** dec),
    collateralAmount: toNum(h.collateralAmount, 10 ** dec),
    collateralSymbol: h.collateralSymbol ?? null,
    status: h.status ?? null,
  };
}

export async function GET(req: NextRequest) {
  return withErrorHandling(async () => {
    const address = req.nextUrl.searchParams.get('address') ?? '';
    if (!ethers.isAddress(address)) {
      return jsonResponse(400, { error: 'address must be a valid 0x wallet address' });
    }
    const addr = address.toLowerCase();
    const client = readClient();
    const nowSec = Math.floor(Date.now() / 1000);

    // Positions and history come from independent indexer calls — cache/report
    // each on its own success, same reasoning as /api/history: one failing
    // must not blank out the other.
    let protections: ReturnType<typeof shapeProtection>[] = [];
    let protectionsError: string | null = null;
    try {
      const raw = await client.api.getUserPositionsFromIndexer(address);
      protections = raw
        .filter((p: any) => {
          const buyer = String(p.buyer ?? '').toLowerCase();
          const seller = String(p.seller ?? '').toLowerCase();
          return buyer === addr || seller === addr;
        })
        .map((p) => shapeProtection(p, nowSec))
        .sort((a, b) => (a.expiryTimestamp ?? Infinity) - (b.expiryTimestamp ?? Infinity));
    } catch (e: any) {
      protectionsError = e?.shortMessage || e?.message || String(e);
      console.error('getUserPositionsFromIndexer failed:', protectionsError);
    }

    let trades: ReturnType<typeof shapeTrade>[] = [];
    let tradesError: string | null = null;
    try {
      const raw = await client.api.getUserHistoryFromIndexer(address);
      trades = raw
        .filter((h: any) => {
          const buyer = String(h.buyer ?? '').toLowerCase();
          const seller = String(h.seller ?? '').toLowerCase();
          return buyer === addr || seller === addr;
        })
        .map((h) => shapeTrade(h))
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    } catch (e: any) {
      tradesError = e?.shortMessage || e?.message || String(e);
      console.error('getUserHistoryFromIndexer failed:', tradesError);
    }

    return jsonResponse(200, { protections, protectionsError, trades, tradesError });
  });
}
