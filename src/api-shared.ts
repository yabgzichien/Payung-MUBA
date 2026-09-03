/**
 * Shared helpers for the Next.js API route handlers — extracted from the old
 * src/server.ts so they can be imported by the app/api route handlers and by
 * tests/wire.test.ts without pulling in Next.js or Node's http module.
 */
import {
  coverageGapDays, impliedStrike, knownTokenSymbol, type Candidate, type ProtectionSpec, type RollEstimate,
} from './core';
import { badgeFor } from './presentation';
import type { Candle } from './spot';

/**
 * Candidates from recent searches, by id, ACROSS all in-flight sessions.
 *
 * This used to be wiped (`cache.clear()`) at the top of every /api/candidates
 * request, on the assumption of "one user, one demo". That assumption breaks
 * the moment two people load the deployed app at once: B's search evicted A's
 * selected candidate, and A's next /api/quote or /api/prepare-tx failed with
 * "Unknown or stale candidate id" in the middle of a purchase. It also broke a
 * single user, because the Explore screen re-searches on every floor change
 * and would evict the selection the Results screen was still holding.
 *
 * Entries are therefore additive and expire on their own clock. Staleness was
 * always enforced by CACHE_MAX_AGE_MS in getCached(), not by the wipe, so
 * dropping the wipe costs no safety. rememberCandidates() bounds the map so an
 * append-only cache cannot grow without limit.
 */
export const cache = new Map<string, { candidate: Candidate; spec: ProtectionSpec; fetchedAt: number }>();

/** A candidate older than this is refused rather than quoted/filled against — the live book moves. */
export const CACHE_MAX_AGE_MS = 3 * 60 * 1000;

/**
 * Hard ceiling on retained candidates. A search returns a handful, and entries
 * live at most CACHE_MAX_AGE_MS, so this is only ever reached under abuse.
 */
const CACHE_MAX_ENTRIES = 500;

/**
 * Records a search's candidates without disturbing anyone else's. Expired
 * entries are swept first; if that is not enough, the oldest are dropped
 * (Map preserves insertion order, so the head is the oldest).
 */
export function rememberCandidates(
  entries: { id: string; candidate: Candidate; spec: ProtectionSpec }[],
  now = Date.now()
): void {
  for (const [id, entry] of cache) {
    if (now - entry.fetchedAt > CACHE_MAX_AGE_MS) cache.delete(id);
  }
  for (const { id, candidate, spec } of entries) {
    // Re-set so a re-searched candidate moves to the tail with a fresh clock.
    cache.delete(id);
    cache.set(id, { candidate, spec, fetchedAt: now });
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export type SpotReading = { price: number; updatedAt: string; feed: string };

/**
 * Price history is expensive to refetch on every render tick — 60s is fresh
 * enough for a chart. Spot and candles are cached SEPARATELY and only when
 * each individually succeeds: they come from different providers with
 * different failure modes, and caching one combined body meant a candles
 * success plus a spot failure cached nothing at all, so every subsequent
 * render re-hammered the rate-limited RPC that just failed.
 */
export const spotCache = new Map<string, { spot: SpotReading; fetchedAt: number }>();
export const candleCache = new Map<string, { candles: Candle[]; fetchedAt: number }>();
export const HISTORY_CACHE_MS = 60 * 1000;

/**
 * Whether this process may sign with the server's own PRIVATE_KEY.
 *
 * SECURITY — Vercel sets `VERCEL=1` in every deployed invocation and never
 * sets it under local `next dev`/`next start`. That's what used to be done by
 * checking whether `server.ts` was the direct entrypoint (only true for
 * `npm run web`, bound to 127.0.0.1) — this is the same guarantee ported to
 * Next.js Route Handlers, which have no equivalent "direct entrypoint" signal.
 *
 * Neither `/api/execute` nor `/api/simulate` has any caller today — the web
 * UI executes through `/api/prepare-tx` and the user's OWN connected wallet,
 * and the CLI calls core.execute() directly. So the safe default is off, and
 * running locally (which does bind to localhost) re-enables them.
 */
export function serverSigningAllowed(): boolean {
  return !process.env.VERCEL || process.env.PAYUNG_ALLOW_SERVER_SIGNING === 'true';
}

export const SERVER_SIGNING_REFUSAL =
  'Server-side signing is disabled on this deployment. This endpoint spends real funds from the ' +
  'server wallet and is only available when the server is bound to localhost (npm run web). ' +
  'Use POST /api/prepare-tx and sign with your own wallet instead.';

/**
 * Whether the watcher's background loop may even be started.
 *
 * Unlike serverSigningAllowed(), this has no override: a Vercel serverless
 * function does not keep a persistent process across invocations, so a
 * setInterval-driven loop (src/watcher-runtime.ts) cannot work there at all —
 * this is a technical constraint, not a policy one. The loop only ever runs
 * inside the long-lived `npm run web` process.
 */
export function watcherLoopAllowed(): boolean {
  return !process.env.VERCEL;
}

export const WATCHER_LOOP_REFUSAL =
  'The watcher loop needs a persistent process and cannot run on this deployment. ' +
  'Run it locally with `npm run web` instead.';

/**
 * Marks an error as caused by bad client input (a malformed spec, a stale
 * candidate id) rather than a genuine server/RPC failure. Route handlers
 * check for this to pick 400 vs 500 — without it, every thrown error looked
 * like a 500, and a caller couldn't tell "fix your request" from "the server
 * broke" by status code alone.
 */
export class ClientError extends Error {}

export function candidateId(c: Candidate): string {
  return `${String(c.raw?.signature ?? '0x').slice(2, 18)}-${Math.round(c.strike)}`;
}

export function toWire(c: Candidate, spec: ProtectionSpec, isTopPick = false) {
  const target = impliedStrike(spec);
  const pctVs = ((target - c.strike) / target) * 100;
  return {
    id: candidateId(c),
    strike: c.strike,
    expiryIso: c.expiry.toISOString(),
    daysToExpiry: c.daysToExpiry,
    pricePerContract: c.pricePerContract,
    iv: c.greeks.iv ?? null,
    coverageGapDays: coverageGapDays(c, spec),
    makerBudget: c.makerBudget,
    /**
     * Human-readable collateral symbol (e.g. "aBasUSDC"), resolved
     * synchronously from a static known-address map — toWire() has no
     * ThetanutsClient to make the async on-chain symbol() call that
     * tokenSymbol() would need. null for any token not in that map; the web
     * UI falls back to the 'aBasUSDC' default the live book actually quotes.
     */
    collateralSymbol: knownTokenSymbol(c.collateralToken),
    /** The per-unit strike the user's stated quantity + total floor implies — what this candidate is being ranked against. */
    impliedStrike: target,
    /** Signed: positive = this strike is BELOW the user's floor (weaker protection); negative = above it (stronger, but pricier). For display. */
    pctVsImpliedStrike: pctVs,
    /**
     * Absolute distance from the user's implied strike. This — not the signed
     * value — gates the "closest match" badge. filterCandidates ranks by
     * absolute distance, so when the book's nearest strikes all sit ABOVE the
     * requested floor, list[0] can be far above it; clamping negatives to 0
     * would badge that as a perfect match and suppress the far-miss warning.
     */
    pctFromImpliedStrike: Math.abs(pctVs),
    coversFullHorizon: c.daysToExpiry >= spec.horizonDays,
    /** Computed by badgeFor() — the single source of truth shared by the web UI and the CLI. */
    badge: badgeFor(c, spec, isTopPick),
  };
}

/**
 * anchorLeg carries a raw SDK order (candidate.raw) that must never reach the
 * client — reuse toWire() for it, same as every other candidate on the wire.
 */
export function toRollEstimateWire(est: RollEstimate, spec: ProtectionSpec) {
  return {
    anchorLeg: toWire(est.anchorLeg, spec),
    anchorPremiumUsd: est.anchorPremiumUsd,
    estimatedLegs: est.estimatedLegs,
    estimatedTotalPremiumUsd: est.estimatedTotalPremiumUsd,
    ivUsed: est.ivUsed,
    spotUsed: est.spotUsed,
  };
}

export function jsonSafe(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

export function getCached(id: string) {
  const entry = cache.get(id);
  if (!entry) throw new ClientError('Unknown or stale candidate id — search again.');
  if (Date.now() - entry.fetchedAt > CACHE_MAX_AGE_MS) {
    cache.delete(id);
    throw new ClientError('This candidate was fetched too long ago — the book may have moved. Search again.');
  }
  return entry;
}

/** Validates a client-supplied spend amount. Missing/undefined defaults to 10; anything present must be sane. */
export function parseSpend(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 10;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ClientError(`spendUsdc must be a positive finite number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Wraps a route handler body so ClientError -> 400, anything else -> 500, same JSON error shape as before. */
export async function withErrorHandling(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e: any) {
    const status =
      e instanceof ClientError
        ? 400
        : typeof e?.status === 'number' && e.status >= 400 && e.status < 600
        ? e.status
        : 500;
    return new Response(jsonSafe({ error: e?.shortMessage || e?.message || String(e) }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(jsonSafe(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Cross-site POSTs from another page's <form>/fetch never carry
 * "application/json" without triggering a CORS preflight — and this app
 * sends no Access-Control-Allow-* headers, so the browser blocks the
 * response before the attacker page can read it. Requiring this header turns
 * a same-origin-only "simple request" (no preflight, would otherwise sail
 * through) into a request the browser refuses to send cross-site at all.
 * Every route here can trigger a real spend (/api/execute) or seed state
 * another route trusts (/api/candidates) — this must be checked before any
 * route body runs.
 */
export function requireJsonContentType(req: Request): Response | null {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse(400, { error: 'Content-Type must be application/json' });
  }
  return null;
}
