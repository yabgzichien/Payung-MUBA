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
import { candidateId, toWire } from './api-shared';

export type ToolResult =
  | { ok: true; data: unknown; numbers: number[] }
  | { ok: false; error: string };

export type ToolContext = {
  /** Candidates seen this turn, so later tools can resolve an id the model quotes back. */
  candidates: Map<string, Candidate>;
  /** The spec under discussion, once known. */
  spec: ProtectionSpec | null;
  /** Address to simulate against. null disables simulate_fill. */
  signerAddress: string | null;
};

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
      for (const c of list) ctx.candidates.set(candidateId(c), c);

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
          ...nums(choice.premiumDelta, choice.gapDays, choice.surplusDays),
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
      const c = ctx.candidates.get(id);
      if (!c) return { ok: false, error: `Unknown candidate id ${id}. Call find_protection first.` };
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
      const c = ctx.candidates.get(id);
      if (!c) return { ok: false, error: `Unknown candidate id ${id}. Call find_protection first.` };
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
      const c = ctx.candidates.get(id);
      if (!c) return { ok: false, error: `Unknown candidate id ${id}. Call find_protection first.` };
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
      const c = ctx.candidates.get(id);
      if (!c) return { ok: false, error: `Unknown candidate id ${id}. Call find_protection first.` };
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
      'TERMINAL ACTION. Hands the user an unsigned transaction to review and sign with their own ' +
      'wallet. This tool never signs and never spends. Call it only after the user has clearly agreed ' +
      'to a specific candidate and amount.',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: { candidateId: { type: 'string' }, spendUsd: { type: 'number' } },
      required: ['candidateId', 'spendUsd'],
    },
    async run({ candidateId: id, spendUsd }, ctx) {
      const c = ctx.candidates.get(id);
      if (!c) return { ok: false, error: `Unknown candidate id ${id}. Call find_protection first.` };
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
