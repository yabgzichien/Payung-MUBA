import type {
  CandidatesResponse,
  ParseResult,
  PrepareTxResponse,
  QuoteResponse,
  ShapedPosition,
  PrepareOpenResponse,
  PreciseCommitmentWire,
} from './types';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `${url} failed with ${res.status}`);
  }
  return data as T;
}

export function parseGoalText(text: string): Promise<ParseResult> {
  return postJson<ParseResult>('/api/parse', { text });
}

export function fetchCandidates(spec: {
  asset: string;
  quantity: number;
  floorTotalUsd: number;
  horizonDays: number;
}): Promise<CandidatesResponse> {
  return postJson<CandidatesResponse>('/api/candidates', { spec });
}

export function fetchQuote(id: string, spendUsdc: number): Promise<QuoteResponse> {
  return postJson<QuoteResponse>('/api/quote', { id, spendUsdc });
}

export function fetchPrepareTx(
  id: string,
  spendUsdc: number,
  takerAddress: string
): Promise<PrepareTxResponse> {
  return postJson<PrepareTxResponse>('/api/prepare-tx', { id, spendUsdc, takerAddress });
}

export async function fetchPositions(address: string): Promise<{
  protections: ShapedPosition[];
  protectionsError: string | null;
}> {
  const res = await fetch(`/api/positions?address=${encodeURIComponent(address)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `positions failed with ${res.status}`);
  return data;
}

export async function fetchSpotPrice(asset: 'ETH' | 'BTC'): Promise<number | null> {
  const res = await fetch(`/api/history?asset=${asset}&days=1`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  return data?.spot?.price ?? null;
}

export type Candle = { t: number; o: number; h: number; l: number; c: number };

/**
 * Real OHLC history plus live spot, in one call.
 *
 * /api/history has always returned both; the Explore chart used to ignore the
 * candles and render a hardcoded 28-bar array under a "14D AGO" axis label —
 * invented market history in a product whose entire pitch is live pricing.
 * `historyError` is surfaced rather than swallowed so a degraded chart reads
 * as degraded instead of as a complete one.
 */
export async function fetchPriceHistory(
  asset: 'ETH' | 'BTC',
  days = 14
): Promise<{ candles: Candle[]; spot: number | null; historyError: string | null }> {
  const res = await fetch(`/api/history?asset=${asset}&days=${days}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { candles: [], spot: null, historyError: data?.error ?? `history failed with ${res.status}` };
  }
  return {
    candles: Array.isArray(data?.candles) ? data.candles : [],
    spot: data?.spot?.price ?? null,
    historyError: data?.historyError ?? null,
  };
}

export function fetchPrepareOpen(params: {
  spec: { asset: string; quantity: number; floorTotalUsd: number; horizonDays: number };
  safe: string;
  maxPremiumPerRollUsd: number;
  totalSpendCapUsd: number;
  maxRolls: number;
}): Promise<PrepareOpenResponse> {
  return postJson<PrepareOpenResponse>('/api/precise/prepare-open', params);
}

export function fetchPrepareCancel(safe: string): Promise<PrepareOpenResponse> {
  return postJson<PrepareOpenResponse>('/api/precise/prepare-cancel', { safe });
}

export async function fetchPreciseCommitment(safe: string): Promise<PreciseCommitmentWire | null> {
  const res = await fetch(`/api/precise/commitment?safe=${encodeURIComponent(safe)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `precise commitment fetch failed with ${res.status}`);
  return data?.commitment ?? null;
}
