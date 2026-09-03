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
