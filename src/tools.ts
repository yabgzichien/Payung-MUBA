/**
 * Transport-agnostic tool registry.
 *
 * ONE definition serves three consumers: the agent loop (OpenAI function
 * calling), the watcher, and the MCP adapter. Defining tools once is what stops
 * the safety filters drifting between surfaces.
 *
 * Every tool declares `numbers` — the flat set of numeric values it returned.
 * That declared array, not a walk over arbitrary JSON, is the allowlist the
 * grounding guard checks model prose against. Declaring it explicitly makes it
 * visible in review when a tool leaks an undeclared number.
 *
 * NOTE: this module imports core.ts and therefore the SDK. It must never be
 * imported by a pure test (HANDOFF.md rule 1).
 */
import {
  findCandidates, quote, payoffCurve, simulate, coverageChoice,
  readClient, type Candidate, type ProtectionSpec,
} from './core';
import { judgeQuote } from './judgment';
import { fetchSpot } from './spot';
import { shapeProtection } from './positions';
import { candidateId, toWire, CACHE_MAX_AGE_MS } from './api-shared';
import { totalFromUnit } from './spec';

export type ToolResult =
  | { ok: true; data: unknown; numbers: number[] }
  | { ok: false; error: string };

export type ToolContext = {
  /** Candidates seen this turn, keyed by id, with when each was fetched. */
  candidates: Map<string, { candidate: Candidate; fetchedAt: number }>;
  /** The spec under discussion, once known. */
  spec: ProtectionSpec | null;
  /** Address to simulate against. null disables simulate_fill. */
  signerAddress: string | null;
};

/**
 * Resolve a candidate id, refusing anything older than CACHE_MAX_AGE_MS — the
 * same staleness rule api-shared.ts's getCached() enforces for the route
 * layer. Without this, the agent surface could quote/judge/simulate/propose
 * against a candidate found long ago, after the live book has moved.
 */
function resolveCandidate(ctx: ToolContext, id: string): Candidate | { error: string } {
  const entry = ctx.candidates.get(id);
  if (!entry) return { error: `Unknown candidate id ${id}. Call find_protection first.` };
  if (Date.now() - entry.fetchedAt > CACHE_MAX_AGE_MS) {
    return { error: `This candidate was fetched too long ago — the book may have moved. Call find_protection again.` };
  }
  return entry.candidate;
}

export type ToolDef = {
  name: string;
  description: string;
  parameters: object;
  /** false => the tool touches funds or produces a signable payload. */
  readOnly: boolean;
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
};

/** Collect finite numbers from a value, for the grounding allowlist. */
function nums(...vals: (number | null | undefined)[]): number[] {
  return vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

export const TOOLS: ToolDef[] = [
  {
    name: 'get_spot',
    description: 'Current spot price of ETH or BTC from the live Chainlink feed on Base.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: { asset: { type: 'string', enum: ['ETH', 'BTC'] } },
      required: ['asset'],
    },
    async run({ asset }) {
      const client = readClient();
      const feed = client.chainConfig.priceFeeds[asset];
      if (!feed) return { ok: false, error: `No price feed configured for ${asset}` };
      const s = await fetchSpot(feed, client.provider);
      return { ok: true, data: s, numbers: nums(s.price) };
    },
  },
  {
    name: 'calculate_floor',
    description:
      'Deterministically compute the total USD floor value for a holding. ' +
      'Call this whenever you know the quantity the user holds and a per-unit floor price ' +
      '(either stated by the user or returned by get_spot), but do NOT yet have the total. ' +
      'Never do this arithmetic yourself — call this tool instead.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        quantity: { type: 'number', description: 'How much of the asset the user holds.' },
        unitFloorUsd: { type: 'number', description: 'The per-unit floor price in USD (e.g. $2,300 per ETH).' },
      },
      required: ['quantity', 'unitFloorUsd'],
    },
    async run({ quantity, unitFloorUsd }: { quantity: number; unitFloorUsd: number }) {
      const q = Number(quantity);
      const u = Number(unitFloorUsd);
      if (!Number.isFinite(q) || q <= 0) {
        return { ok: false as const, error: `quantity must be a positive number, got: ${JSON.stringify(quantity)}` };
      }
      if (!Number.isFinite(u) || u <= 0) {
        return { ok: false as const, error: `unitFloorUsd must be a positive number, got: ${JSON.stringify(unitFloorUsd)}` };
      }
      const floorTotalUsd = totalFromUnit(u, q);
      return {
        ok: true as const,
        data: { quantity: q, unitFloorUsd: u, floorTotalUsd },
        numbers: nums(q, u, floorTotalUsd),
      };
    },
  },
  {
    name: 'find_protection',
    description:
      'Find live, currently-fillable put options that put a floor under a holding. ' +
      'Returns candidates ranked with fully-covering options first, plus the price of full coverage. ' +
      'Returns an empty list when nothing on the book fits — never a substitute.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        asset: { type: 'string', enum: ['ETH', 'BTC'] },
        quantity: { type: 'number', description: 'How much of the asset the user holds.' },
        floorTotalUsd: { type: 'number', description: 'Total USD value the whole holding must retain.' },
        horizonDays: { type: 'number', description: 'Days until the user’s deadline.' },
      },
      required: ['asset', 'quantity', 'floorTotalUsd', 'horizonDays'],
    },
    async run(args, ctx) {
      const spec: ProtectionSpec = {
        asset: args.asset, quantity: args.quantity,
        floorTotalUsd: args.floorTotalUsd, horizonDays: args.horizonDays,
      };
      const list = await findCandidates(spec);
      ctx.spec = spec;
      for (const c of list) ctx.candidates.set(candidateId(c), { candidate: c, fetchedAt: Date.now() });

      const choice = coverageChoice(list, spec);
      const wire = list.map((c, i) => toWire(c, spec, i === 0));
      return {
        ok: true,
        data: {
          candidates: wire,
          hasFullCover: choice.best !== null,
          premiumDelta: choice.premiumDelta,
          gapDays: choice.gapDays,
          surplusDays: choice.surplusDays,
          note: list.length === 0
            ? 'Nothing on the live book matches. Do not substitute a different floor or date; say so and offer to loosen one constraint.'
            : null,
        },
        numbers: [
          ...wire.flatMap((w) => nums(w.strike, w.daysToExpiry, w.pricePerContract, w.coverageGapDays, w.makerBudget, w.impliedStrike, w.pctFromImpliedStrike, w.iv)),
          ...nums(spec.quantity, spec.floorTotalUsd, spec.horizonDays, choice.premiumDelta, choice.gapDays, choice.surplusDays),
        ],
      };
    },
  },
  {
    name: 'quote_candidate',
    description: 'Price a fill of a specific candidate against live protocol math (previewFillOrder).',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        candidateId: { type: 'string' },
        spendUsd: { type: 'number', description: 'USD the user wants to spend on premium.' },
      },
      required: ['candidateId', 'spendUsd'],
    },
    async run({ candidateId: id, spendUsd }, ctx) {
      const resolved = resolveCandidate(ctx, id);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      const c = resolved;
      const q = await quote(c, spendUsd);
      return {
        ok: true,
        data: {
          spendUsdc: q.spendUsdc, capped: q.capped, premiumUsdc: q.premiumUsdc,
          contracts: q.contracts, strike: q.strike, pricePerContract: q.pricePerContract,
          expiryIso: q.expiry.toISOString(), yourSide: q.yourSide,
        },
        numbers: nums(q.spendUsdc, q.premiumUsdc, q.contracts, q.strike, q.pricePerContract, q.requestedUsdc),
      };
    },
  },
  {
    name: 'judge_candidate',
    description:
      'Deterministic verdict on whether a quote is worth buying: premium as a percentage of the ' +
      'floor it protects, plus coverage-gap warnings. Computed, never guessed.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: { candidateId: { type: 'string' }, spendUsd: { type: 'number' } },
      required: ['candidateId', 'spendUsd'],
    },
    async run({ candidateId: id, spendUsd }, ctx) {
      const resolved = resolveCandidate(ctx, id);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      const c = resolved;
      if (!ctx.spec) return { ok: false, error: 'No protection spec known yet. Call find_protection first.' };
      const q = await quote(c, spendUsd);
      const gap = Math.max(0, ctx.spec.horizonDays - c.daysToExpiry);
      const j = judgeQuote(q, gap);
      return {
        ok: true,
        data: { verdict: j.verdict, reasons: j.reasons, premiumPctOfProtection: j.premiumPctOfProtection },
        numbers: nums(j.premiumPctOfProtection, gap),
      };
    },
  },
  {
    name: 'payoff_at',
    description: 'Protected value at given spot prices, for explaining the floor concretely.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        candidateId: { type: 'string' },
        spendUsd: { type: 'number' },
        spotPrices: { type: 'array', items: { type: 'number' }, description: 'Spot prices to evaluate.' },
      },
      required: ['candidateId', 'spendUsd', 'spotPrices'],
    },
    async run({ candidateId: id, spendUsd, spotPrices }, ctx) {
      const resolved = resolveCandidate(ctx, id);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      const c = resolved;
      const q = await quote(c, spendUsd);
      const lo = Math.min(...spotPrices), hi = Math.max(...spotPrices);
      const curve = payoffCurve(q, [lo, hi], Math.max(1, spotPrices.length - 1));
      return {
        ok: true,
        data: { points: curve },
        numbers: curve.flatMap((p) => nums(p.spot, p.pnl)),
      };
    },
  },
  {
    name: 'list_positions',
    description:
      'Protection the user already holds: strike, expiry, days remaining, premium paid, and status. ' +
      'Use this before suggesting new protection, so you do not sell someone a floor they already have.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: { address: { type: 'string', description: 'Wallet address to look up.' } },
      required: ['address'],
    },
    async run({ address }) {
      const client = readClient();
      const nowSec = Math.floor(Date.now() / 1000);
      const addr = String(address).toLowerCase();
      // Mirror the exact indexer call app/api/positions/route.ts already makes:
      // client.api.getUserPositionsFromIndexer(address), filtered to rows where
      // the caller is buyer or seller. (ThetanutsClient has no `.positions`
      // module — verified against the SDK's own .d.ts — so that shape would
      // fail to compile; this is the real, already-reviewed call.)
      const raw: any[] = await client.api.getUserPositionsFromIndexer(address);
      const shaped = raw
        .filter((p: any) => {
          const buyer = String(p.buyer ?? '').toLowerCase();
          const seller = String(p.seller ?? '').toLowerCase();
          return buyer === addr || seller === addr;
        })
        .map((p) => shapeProtection(p, nowSec))
        .sort((a, b) => (a.expiryTimestamp ?? Infinity) - (b.expiryTimestamp ?? Infinity));
      return {
        ok: true,
        data: shaped,
        numbers: shaped.flatMap((p) => nums(p.strike, p.contracts, p.premiumPaid, p.daysToExpiry, p.pnlUsd, p.collateralAmount, p.entryTimestamp, p.expiryTimestamp)),
      };
    },
  },
  {
    name: 'simulate_fill',
    description:
      'Free dry run of the exact fill against current chain state (callStaticFillOrder), using ' +
      'Payung\'s own operating wallet — NOT a simulation of the connected user\'s specific wallet ' +
      'balance or allowances. Costs nothing and moves no funds.',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: { candidateId: { type: 'string' }, spendUsd: { type: 'number' } },
      required: ['candidateId', 'spendUsd'],
    },
    async run({ candidateId: id, spendUsd }, ctx) {
      if (!ctx.signerAddress) {
        return { ok: false, error: 'Simulation needs a connected wallet address. Ask the user to connect one.' };
      }
      const resolved = resolveCandidate(ctx, id);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      const c = resolved;
      const r = await simulate(c, spendUsd);
      // simulate()'s real return is { ok, result?, error? } — result (when present)
      // carries bigint gas fields that JSON.stringify cannot serialize, and there
      // is no clean end-user-citable number on this type at all. Strip to a safe,
      // JSON-serializable summary instead of returning `result` verbatim.
      return {
        ok: true,
        data: { simulationOk: r.ok, error: r.error ?? null },
        numbers: [],
      };
    },
  },
  {
    name: 'propose_execution',
    description:
      'TERMINAL ACTION. Prepares a summary of the proposed trade (candidate, spend amount, ' +
      'strike, expiry, premium) for the user to review. This tool never signs or spends money ' +
      'itself — call it only after the user has clearly agreed to a specific candidate and amount. ' +
      'The user completes the actual transaction separately, in their own wallet, outside this tool.',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: { candidateId: { type: 'string' }, spendUsd: { type: 'number' } },
      required: ['candidateId', 'spendUsd'],
    },
    async run({ candidateId: id, spendUsd }, ctx) {
      const resolved = resolveCandidate(ctx, id);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      const c = resolved;
      const q = await quote(c, spendUsd);
      return {
        ok: true,
        data: {
          handoff: 'proposal',
          candidateId: id,
          spendUsdc: q.spendUsdc,
          premiumUsdc: q.premiumUsdc,
          strike: q.strike,
          expiryIso: q.expiry.toISOString(),
          message: 'Proposal prepared. The user must review and sign it in their own wallet.',
        },
        numbers: nums(q.spendUsdc, q.premiumUsdc, q.strike, q.contracts),
      };
    },
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** OpenAI chat-completions `tools` payload. The MCP adapter reads the same fields. */
export function openAiToolSchemas() {
  return TOOLS.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
