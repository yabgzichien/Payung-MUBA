# Payung — AI Agent & Coverage Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Payung's LLM from a four-field parser into a tool-calling agent whose every user-visible number is provably grounded in live protocol data, and fix four verified defects where the UI knows more than it tells the user.

**Architecture:** One transport-agnostic tool registry (`src/tools.ts`) wraps the existing `core.ts` and is consumed by three surfaces — a chat agent loop, a local re-hedge watcher, and (stretch) an MCP adapter. Every user-facing number the model writes is checked against an allowlist that tools declare explicitly. Candidate ranking becomes two-dimensional (floor *and* deadline) so a short-dated option can never again be labelled an exact match.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Next.js 16 app router, vitest, ethers v6, `@thetanuts-finance/thetanuts-client` 0.3.0, Gonka Router (OpenAI-compatible) with `deepseek-ai/DeepSeek-V4-Flash-0731`.

**Spec:** [docs/superpowers/specs/2026-08-30-agent-and-coverage-integrity-design.md](../specs/2026-08-30-agent-and-coverage-integrity-design.md)

## Global Constraints

- **Import specifiers use `.js`** even for `.ts` sources (`import { x } from '../src/core.js'`). Match existing tests exactly.
- **Pure tests touch no network and import no SDK.** `HANDOFF.md` rule 1. `src/tools.ts`, `src/core.ts`, and `src/agent.ts` must never be imported by a pure test — only `src/spec.ts`, `src/presentation.ts`, `src/grounding.ts`, `src/policy.ts`, `src/commitments.ts` and the pure exports re-tested through existing seams.
- **Never bypass `filterCandidates`.** Its `!isCall` and `takerIsBuyer` predicates are the only thing preventing a user from writing (selling) an option. No new surface may query the book directly.
- **`serverSigningAllowed()` in `src/api-shared.ts` is not modified by any task.** Vercel must stay unable to sign.
- **The model never originates a user-visible number.** Any assistant prose reaching a user passes `checkGrounding` first. No exceptions, no bypass flag.
- **Test runner:** `npx vitest run <path>` for a single file, `npm test` for all.
- **Commit after every task.** Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`).

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/presentation.ts` | Pure display decisions: coverage badges. Shared by web + CLI. |
| `src/grounding.ts` | Pure numeric-grounding guard. No I/O, no model. |
| `src/positions.ts` | Position shaping extracted from the route, shared by route/tool/watcher. |
| `src/tools.ts` | Transport-agnostic tool registry over `core.ts`. |
| `src/chat.ts` | Tool-calling chat transport (Gonka) + message types. The test seam. |
| `src/agent.ts` | The bounded agent loop. Orchestration only. |
| `src/commitments.ts` | Local record of what the user asked for, keyed to a tx. |
| `src/policy.ts` | Pure roll-decision logic + policy validation. |
| `src/watcher.ts` | The daemon. Thin — delegates to `policy.ts` and `tools.ts`. |
| `app/api/agent/route.ts` | HTTP face over `agent.ts`. |
| `mcp/server.ts` | *(stretch)* MCP adapter over the registry. |

**Modified:** `src/core.ts` (ranking), `src/api-shared.ts` (wire fields), `public/app.js` (badges, disclosure), `app/_markup.ts` (chat pane, disclosure), `app/api/positions/route.ts` (delegate to `src/positions.ts`), `src/cli.ts` (agent + watch commands), `package.json` (scripts), `README.md` (proof).

---

# Phase 0 — Banked trade and settlement spike

### Task 1: Settlement spike

Answer empirically whether a cash-settled OptionBook put pays out automatically after expiry. This is a spike: the output is a findings note, and the script is throwaway.

**Files:**
- Create: `scripts/settlement-probe.ts` (throwaway)
- Create: `docs/settlement-findings.md`

**Interfaces:**
- Consumes: `readClient()` from `src/core.js`
- Produces: the copy decision consumed by Task 19

- [ ] **Step 1: Write the probe script**

```ts
// scripts/settlement-probe.ts
// THROWAWAY. Answers one question: who settles an expired book put, and when?
import 'dotenv/config';
import { readClient } from '../src/core.js';

async function main() {
  const client = readClient();
  // The same indexer app/api/positions/route.ts already queries.
  const res: any = await client.positions.list({ limit: 500 });
  const rows: any[] = res?.positions ?? res?.data ?? res ?? [];

  const settled = rows.filter(
    (p) => p.optionStatus === 'settled-itm' || p.optionStatus === 'settled-otm'
  );
  const buyers = settled.filter((p) => p.side === 'buyer');

  const explicit = buyers.filter((p) => p.settlement?.explicitDecision === true).length;
  const automatic = buyers.filter((p) => p.settlement?.explicitDecision === false).length;

  const delays = buyers
    .map((p) => Number(p.closeTimestamp) - Number(p.option?.expiry))
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);

  const median = delays.length ? delays[Math.floor(delays.length / 2)] : null;

  console.log(JSON.stringify({
    totalRows: rows.length,
    settledBuyerPositions: buyers.length,
    explicitDecisionTrue: explicit,
    explicitDecisionFalse: automatic,
    medianSettlementDelaySec: median,
    awaitingSettlement: rows.filter((p) => p.optionStatus === 'expired-awaiting-settlement').length,
    sampleCloseTxHashes: buyers.slice(0, 5).map((p) => p.closeTxHash),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/settlement-probe.ts`
Expected: a JSON summary. If `client.positions.list` has a different name, inspect `app/api/positions/route.ts` for the exact call it already makes and mirror that — do not invent an API.

- [ ] **Step 3: Inspect two settling transactions on BaseScan**

Take two hashes from `sampleCloseTxHashes` and open `https://basescan.org/tx/<hash>`. Record the **sender** of each. A consistent sender that is neither buyer nor seller means a keeper settles automatically.

- [ ] **Step 4: Write the findings note**

```markdown
<!-- docs/settlement-findings.md -->
# Settlement behaviour — measured, 2026-08-30

**Question:** after expiry, does a cash-settled OptionBook put pay the buyer
automatically, or must someone call something?

## Method
Queried the Thetanuts indexer for settled buyer-side positions and tabulated
`settlement.explicitDecision`, then inspected settling transactions on BaseScan.

## Numbers
- Settled buyer positions sampled: <N>
- `explicitDecision: false` (automatic): <N>
- `explicitDecision: true` (explicit): <N>
- Median delay expiry → settlement: <N> seconds
- Positions currently `expired-awaiting-settlement`: <N>
- Settling sender(s): <address(es)>

## Conclusion
<One of: "Settlement is keeper-automatic; payout arrives without user action,
typically within <N>." / "The holder must act; a claim path is required." /
"Ambiguous; the UI states the ambiguity.">

## Confirmation
Asked the Thetanuts mentor in parallel. Response: <record it, or "pending">.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/settlement-probe.ts docs/settlement-findings.md
git commit -m "docs: measure OptionBook settlement behaviour from live indexer data"
```

---

### Task 2: Bank the two trades

Operational, not code. Track 02's bar is unmet until this is done.

**Files:**
- Modify: `README.md` (Proof section)

- [ ] **Step 1: Preflight**

Run: `npm run whoami` — confirm the burner holds ~$20 USDC and ~$1 ETH on Base.
Run: `npm run preflight -- 1 2300 14` — confirm RPC latency and at least three fillable candidates.

- [ ] **Step 2: Execute Position A (the proof trade)**

Run the full web flow, or `npm run execute -- 1 2300 10`. Save the BaseScan URL, the exact paid figure from the fill receipt's Transfer logs, and a screen recording of the whole flow.

- [ ] **Step 3: Execute Position B (the watcher subject)**

Pick the **shortest-dated** fillable put available, sized at the minimum fill. Its expiry must fall inside the demo window so Task 16's trigger fires on real data. Save its BaseScan URL and option address.

- [ ] **Step 4: Update the README proof section**

Replace the placeholder in `README.md` with the real BaseScan URL and the real paid figure. Note Position B separately as the watcher subject with its expiry date.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: record banked mainnet fills — Track 02 proof"
```

> Position B's commitment record is written by hand in Task 14, Step 6, since it predates the commitment store.

---

# Phase 1 — Coverage-first ranking

### Task 3: `rankCandidates`

**Files:**
- Modify: `src/core.ts` (add `rankCandidates`; `filterCandidates` delegates ordering to it)
- Test: `tests/ranking.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `ProtectionSpec`, `impliedStrike` from `src/core.js`
- Produces: `rankCandidates(eligible: Candidate[], spec: ProtectionSpec): Candidate[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ranking.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ranking.test.ts`
Expected: FAIL — `rankCandidates is not a function`.

- [ ] **Step 3: Implement `rankCandidates`**

Add to `src/core.ts` immediately above `filterCandidates`:

```ts
/**
 * Order candidates by BOTH dimensions of the user's request.
 *
 * The previous single sort ranked purely by strike distance, so an option
 * expiring days before the stated deadline could rank first and be badged an
 * exact match. The user asks for a floor AND a date; ranking must honour both.
 *
 * Fully-covering candidates come first, each partition internally ordered by
 * strike distance (the original comparator, unchanged). One slot is reserved
 * for the cheapest short-dated candidate so a fully-covering book cannot hide
 * the cheaper partial option the user is entitled to compare against.
 */
export function rankCandidates(eligible: Candidate[], spec: ProtectionSpec): Candidate[] {
  const target = impliedStrike(spec);
  const byStrike = (a: Candidate, b: Candidate) =>
    Math.abs(a.strike - target) - Math.abs(b.strike - target);

  const covering = eligible.filter((c) => c.daysToExpiry >= spec.horizonDays).sort(byStrike);
  const short = eligible.filter((c) => c.daysToExpiry < spec.horizonDays).sort(byStrike);

  const LIMIT = 8;
  if (covering.length === 0 || short.length === 0) {
    return [...covering, ...short].slice(0, LIMIT);
  }

  // Reserve the final slot for the cheapest short candidate.
  const cheapestShort = short.reduce((a, b) => (b.pricePerContract < a.pricePerContract ? b : a));
  const head = [...covering, ...short.filter((c) => c !== cheapestShort)].slice(0, LIMIT - 1);
  return [...head, cheapestShort];
}
```

- [ ] **Step 4: Delegate ordering from `filterCandidates`**

In `src/core.ts`, replace the trailing `.sort(...)` and `.slice(0, 8)` of `filterCandidates` with a call to `rankCandidates`. The filter chain up to and including the two `daysToExpiry` window filters is unchanged:

```ts
      .filter((c) => c.daysToExpiry >= spec.horizonDays * 0.6)
      .filter((c) => c.daysToExpiry <= spec.horizonDays * 2.5)
  );
  return rankCandidates(eligible, spec);
}
```

Bind the filter chain to a `const eligible = book.filter(...)...;` and return `rankCandidates(eligible, spec)`. Delete the old comparator and `.slice(0, 8)` — `rankCandidates` owns both now.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. `tests/filter.test.ts` must still pass — its assertions are about filtering, not ordering. If an ordering assertion there now fails, the test was asserting the old strike-only behaviour and should be updated to reflect coverage-first ranking.

- [ ] **Step 6: Commit**

```bash
git add src/core.ts tests/ranking.test.ts
git commit -m "fix: rank fully-covering options above short-dated ones

Ranking sorted by strike distance alone, so an option expiring before the
user's stated deadline could rank first. Partition by coverage, sort by
strike within each partition, and reserve a slot for the cheapest partial."
```

---

### Task 4: `coverageChoice`

Makes the cost of full coverage a stated trade rather than a silent upsell.

**Files:**
- Modify: `src/core.ts`
- Test: `tests/coverage-choice.test.ts`

**Interfaces:**
- Consumes: `rankCandidates` output, `ProtectionSpec`
- Produces: `CoverageChoice` type and `coverageChoice(ranked, spec): CoverageChoice`

- [ ] **Step 1: Write the failing test**

```ts
// tests/coverage-choice.test.ts
import { describe, it, expect } from 'vitest';
import { coverageChoice } from '../src/core.js';
import { makeCandidate } from './fixtures.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

describe('coverageChoice', () => {
  it('names the premium delta between full coverage and the cheaper partial', () => {
    const covering = makeCandidate({ strike: 2300, daysToExpiry: 16, pricePerContract: 20 });
    const short = makeCandidate({ strike: 2300, daysToExpiry: 12, pricePerContract: 17.45 });
    const c = coverageChoice([covering, short], spec);
    expect(c.best?.daysToExpiry).toBe(16);
    expect(c.cheaperShort?.pricePerContract).toBe(17.45);
    expect(c.premiumDelta).toBeCloseTo(2.55, 2);
    expect(c.gapDays).toBeCloseTo(2, 5);
    expect(c.surplusDays).toBeCloseTo(2, 5);
  });

  it('reports a negative delta when full coverage is actually cheaper', () => {
    const covering = makeCandidate({ strike: 2300, daysToExpiry: 16, pricePerContract: 10 });
    const short = makeCandidate({ strike: 2300, daysToExpiry: 12, pricePerContract: 17 });
    const c = coverageChoice([covering, short], spec);
    expect(c.premiumDelta).toBeCloseTo(-7, 5);
  });

  it('returns nulls for the missing side when a partition is empty', () => {
    const onlyShort = makeCandidate({ daysToExpiry: 10 });
    const c = coverageChoice([onlyShort], spec);
    expect(c.best).toBeNull();
    expect(c.premiumDelta).toBeNull();
    expect(c.cheaperShort?.daysToExpiry).toBe(10);
  });

  it('returns all nulls for an empty list', () => {
    const c = coverageChoice([], spec);
    expect(c.best).toBeNull();
    expect(c.cheaperShort).toBeNull();
    expect(c.premiumDelta).toBeNull();
    expect(c.gapDays).toBeNull();
    expect(c.surplusDays).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coverage-choice.test.ts`
Expected: FAIL — `coverageChoice is not a function`.

- [ ] **Step 3: Implement**

Add to `src/core.ts` below `rankCandidates`:

```ts
/**
 * The coverage trade-off, computed so the UI can state it instead of implying it.
 *
 * Ranking full coverage first surfaces a more expensive option by default.
 * Presenting that without naming the price difference is an upsell; naming it
 * ("$2.55 more buys the 4 days you asked for") is a disclosure.
 */
export type CoverageChoice = {
  best: Candidate | null;
  cheaperShort: Candidate | null;
  /** best − cheaperShort, per contract. Negative when full coverage is cheaper. */
  premiumDelta: number | null;
  /** Days cheaperShort falls short of the stated deadline. */
  gapDays: number | null;
  /** Days best runs past the stated deadline. */
  surplusDays: number | null;
};

export function coverageChoice(ranked: Candidate[], spec: ProtectionSpec): CoverageChoice {
  const covering = ranked.filter((c) => c.daysToExpiry >= spec.horizonDays);
  const short = ranked.filter((c) => c.daysToExpiry < spec.horizonDays);

  const best = covering[0] ?? null;
  const cheaperShort = short.length
    ? short.reduce((a, b) => (b.pricePerContract < a.pricePerContract ? b : a))
    : null;

  return {
    best,
    cheaperShort,
    premiumDelta:
      best && cheaperShort ? best.pricePerContract - cheaperShort.pricePerContract : null,
    gapDays: cheaperShort ? spec.horizonDays - cheaperShort.daysToExpiry : null,
    surplusDays: best ? best.daysToExpiry - spec.horizonDays : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/coverage-choice.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core.ts tests/coverage-choice.test.ts
git commit -m "feat: compute the full-coverage premium trade-off explicitly"
```

---

### Task 5: `badgeFor`

Retires `EXACT MATCH`, which names one axis while implying two, and moves badge logic out of untestable inline JS.

**Files:**
- Create: `src/presentation.ts`
- Test: `tests/presentation.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `ProtectionSpec`, `impliedStrike` from `src/spec.js`
- Produces: `CoverageState`, `Badge`, `badgeFor(c, spec, isTopPick): Badge`, `CLOSEST_MATCH_MAX_PCT`

> **Import rule:** this module imports `impliedStrike` from `src/spec.js`, never from `src/core.js`, so it stays free of dotenv and the SDK and can be unit-tested. Same reason `src/intent.ts` does it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/presentation.test.ts
import { describe, it, expect } from 'vitest';
import { badgeFor } from '../src/presentation.js';
import { makeCandidate } from './fixtures.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

describe('badgeFor', () => {
  it('badges an exact floor that covers the horizon as good', () => {
    const b = badgeFor(makeCandidate({ strike: 2300, daysToExpiry: 16 }), spec, true);
    expect(b.state).toBe('surplus');
    expect(b.tone).toBe('good');
    expect(b.text).toContain('FULL COVER');
  });

  it('never emits a good tone for a short-dated candidate', () => {
    const b = badgeFor(makeCandidate({ strike: 2300, daysToExpiry: 11.9 }), spec, true);
    expect(b.tone).toBe('warn');
    expect(b.state).toBe('short');
    expect(b.text).toContain('2.1 DAYS SHORT');
  });

  it('never emits the retired EXACT MATCH text', () => {
    const b = badgeFor(makeCandidate({ strike: 2300, daysToExpiry: 11.9 }), spec, true);
    expect(b.text).not.toContain('EXACT MATCH');
  });

  it('reports coverage before strike proximity when both are wrong', () => {
    // 8.4d short AND 8.7% off the floor — coverage is the headline defect.
    const b = badgeFor(makeCandidate({ strike: 2100, daysToExpiry: 9 }), spec, true);
    expect(b.state).toBe('short');
  });

  it('flags a far strike that does cover the horizon', () => {
    const b = badgeFor(makeCandidate({ strike: 2100, daysToExpiry: 16 }), spec, true);
    expect(b.state).toBe('far-from-floor');
    expect(b.tone).toBe('warn');
  });

  it('labels a non-top pick as the user’s own choice', () => {
    const b = badgeFor(makeCandidate({ strike: 2290, daysToExpiry: 16 }), spec, false);
    expect(b.text).toContain('YOUR PICK');
    expect(b.tone).toBe('neutral');
  });

  it('says FULL COVER with no surplus when expiry lands on the deadline', () => {
    const b = badgeFor(makeCandidate({ strike: 2300, daysToExpiry: 14 }), spec, true);
    expect(b.state).toBe('full');
    expect(b.tone).toBe('good');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/presentation.test.ts`
Expected: FAIL — cannot resolve `../src/presentation.js`.

- [ ] **Step 3: Implement**

```ts
// src/presentation.ts
/**
 * Pure display decisions, shared by the web UI and the CLI.
 *
 * Badge logic used to live inline in public/app.js, where it could not be
 * tested — and where `EXACT MATCH` was set from strike distance ALONE while
 * reading to a user as "exactly what you asked for". A badge must state both
 * dimensions of the request: the floor and the deadline.
 */
import { impliedStrike, type ProtectionSpec } from './spec.js';
import type { Candidate } from './core.js'; // type-only: no runtime SDK import

export type CoverageState = 'full' | 'surplus' | 'short' | 'far-from-floor';
export type Badge = { state: CoverageState; text: string; tone: 'good' | 'warn' | 'neutral' };

/** Beyond this distance from the implied floor, a match is called far, not close. */
export const CLOSEST_MATCH_MAX_PCT = 5;

export function badgeFor(c: Candidate, spec: ProtectionSpec, isTopPick: boolean): Badge {
  const target = impliedStrike(spec);
  const pctVs = ((target - c.strike) / target) * 100;
  const dist = Math.abs(pctVs);
  const sign = pctVs >= 0 ? '−' : '+';
  const floorPart = dist < 0.01 ? 'EXACT FLOOR' : `${sign}${dist.toFixed(1)}% FLOOR`;

  // Coverage is decided BEFORE strike proximity: a floor that evaporates early
  // is a worse defect than a floor a fraction of a percent off.
  const gap = spec.horizonDays - c.daysToExpiry;
  if (gap > 0.05) {
    return { state: 'short', tone: 'warn', text: `${gap.toFixed(1)} DAYS SHORT · ${floorPart}` };
  }

  if (dist > CLOSEST_MATCH_MAX_PCT) {
    return {
      state: 'far-from-floor',
      tone: 'warn',
      text: `FAR FROM YOUR FLOOR · ${sign}${dist.toFixed(1)}%`,
    };
  }

  if (!isTopPick) {
    return { state: gap < -0.05 ? 'surplus' : 'full', tone: 'neutral', text: `YOUR PICK · ${floorPart}` };
  }

  return {
    state: gap < -0.05 ? 'surplus' : 'full',
    tone: 'good',
    text: `FULL COVER · ${floorPart}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/presentation.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/presentation.ts tests/presentation.test.ts
git commit -m "feat: two-dimensional coverage badge, retiring EXACT MATCH

EXACT MATCH was set from strike distance alone and read as 'exactly what you
asked for' on options expiring days early. Badges now state coverage first."
```

---

### Task 6: Surface coverage at Step 2

**Files:**
- Modify: `src/api-shared.ts` (`toWire` gains coverage fields)
- Modify: `app/api/candidates/route.ts` (return `coverageChoice`)
- Modify: `public/app.js:528-565` (use the wire badge; render the trade-off line)

**Interfaces:**
- Consumes: `badgeFor` from `src/presentation.js`, `coverageChoice` from `src/core.js`
- Produces: wire fields `badge: Badge`, `coversFullHorizon: boolean`; response field `coverage: CoverageChoice`

- [ ] **Step 1: Add coverage fields to the wire shape**

In `src/api-shared.ts`, import `badgeFor` and extend `toWire`'s signature and return:

```ts
import { badgeFor } from './presentation.js';

export function toWire(c: Candidate, spec: ProtectionSpec, isTopPick = false) {
  // ... existing fields unchanged ...
  return {
    // ... existing fields ...
    coversFullHorizon: c.daysToExpiry >= spec.horizonDays,
    badge: badgeFor(c, spec, isTopPick),
  };
}
```

- [ ] **Step 2: Pass top-pick position and coverage from the candidates route**

In `app/api/candidates/route.ts`, map with the index so the first candidate is the top pick, and include the trade-off:

```ts
import { coverageChoice } from '@/src/core';

const candidates = list.map((c, i) => toWire(c, spec, i === 0));
const choice = coverageChoice(list, spec);
return jsonResponse(200, {
  candidates,
  coverage: {
    premiumDelta: choice.premiumDelta,
    gapDays: choice.gapDays,
    surplusDays: choice.surplusDays,
    hasFullCover: choice.best !== null,
  },
});
```

Keep the existing response key for the candidate array so `public/app.js` is not broken by the rename; if the route currently returns a bare array, wrap it and update the single call site in `app.js`.

- [ ] **Step 3: Use the server-computed badge in the UI**

In `public/app.js`, replace the badge block at lines 536-548 (`let badgeText = 'CLOSEST MATCH'` through the `else` branch) with:

```js
  // Badge is computed server-side by badgeFor() so the web UI and CLI can never
  // disagree, and so the logic is unit-tested. Do not recompute it here.
  const badge = selected.badge;
  const badgeText = badge.text;
  const badgeClass =
    badge.tone === 'warn' ? 'badge-chip warn'
    : badge.tone === 'neutral' ? 'badge-chip neutral'
    : 'badge-chip';
```

Leave `isFar` and the far-miss warning block intact — it keys off `pctFromImpliedStrike`, which `toWire` still returns.

- [ ] **Step 4: Render the coverage trade-off line at Step 2**

Immediately after the `heroDetails` assignment in `public/app.js`, add:

```js
  // The cost of full coverage, stated. Ranking now puts covering options first,
  // which surfaces a pricier option by default; showing the delta makes that a
  // disclosed trade rather than a silent upsell.
  const cov = state.coverage;
  const tradeEl = document.getElementById('coverageTrade');
  if (cov && cov.premiumDelta !== null && cov.gapDays !== null) {
    const more = cov.premiumDelta >= 0;
    tradeEl.style.display = 'block';
    tradeEl.textContent = more
      ? `${formatMoney(cov.premiumDelta)} more buys the ${cov.gapDays.toFixed(1)} days the cheaper offer is missing.`
      : `Full coverage is also ${formatMoney(Math.abs(cov.premiumDelta))} cheaper than the shorter offer.`;
  } else if (cov && !cov.hasFullCover) {
    tradeEl.style.display = 'block';
    tradeEl.textContent =
      'Nothing on the live book covers your full deadline. Every offer below ends early — Payung will not paper over that.';
  } else {
    tradeEl.style.display = 'none';
  }
```

Store the response's `coverage` object onto `state.coverage` where the candidates response is handled.

- [ ] **Step 5: Add the container element**

In `app/_markup.ts`, inside the candidate/hero card block, add below the hero details line:

```html
<p id="coverageTrade" style="display:none; margin: 8px 0 0; font-size: 13.5px; color: oklch(0.78 0.01 80); line-height: 1.5;"></p>
```

- [ ] **Step 6: Verify in the browser**

Run: `npm run web`, then ask for `1 ETH, $2,300 floor, 14 days`.
Expected: the top card shows `FULL COVER · …` in the good tone when a covering option exists, or `N DAYS SHORT · …` in the warn tone when none does; the trade-off line appears beneath it; `EXACT MATCH` never appears.

- [ ] **Step 7: Commit**

```bash
git add src/api-shared.ts app/api/candidates/route.ts public/app.js app/_markup.ts
git commit -m "feat: disclose coverage state and its price at candidate selection

The 2.1-day gap previously appeared only at Step 3, after the user had
anchored on a card badged EXACT MATCH."
```

---

# Phase 2a — The tool registry

### Task 7: Extract position shaping

`shapeProtection` currently lives inside the route. The watcher and the `list_positions` tool both need it, and `decideRoll` must stay pure and route-free.

**Files:**
- Create: `src/positions.ts`
- Modify: `app/api/positions/route.ts` (import instead of define)
- Test: `tests/positions-shape.test.ts`

**Interfaces:**
- Produces: `ShapedPosition` type, `shapeProtection(p: any, nowSec: number): ShapedPosition`, `normalizeHash(raw: unknown): string | null`

- [ ] **Step 1: Write the failing test**

```ts
// tests/positions-shape.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeHash, shapeProtection } from '../src/positions.js';

describe('normalizeHash', () => {
  it('adds the 0x prefix the indexer omits', () => {
    const bare = 'a'.repeat(64);
    expect(normalizeHash(bare)).toBe(`0x${bare}`);
  });

  it('lowercases and preserves an already-prefixed hash', () => {
    const h = `0x${'A'.repeat(64)}`;
    expect(normalizeHash(h)).toBe(`0x${'a'.repeat(64)}`);
  });

  it('rejects a wrong-length or empty value', () => {
    expect(normalizeHash('0xdeadbeef')).toBeNull();
    expect(normalizeHash('')).toBeNull();
    expect(normalizeHash(null)).toBeNull();
  });
});

describe('shapeProtection', () => {
  it('scales strike by 1e8 and premium by collateral decimals', () => {
    const s = shapeProtection({
      id: '1',
      optionAddress: '0xopt',
      option: { strikes: ['230000000000'], expiry: 1_790_000_000, underlying: '0xeth' },
      amount: '1000000',
      entryPrice: '12081192',
      collateralDecimals: 6,
      optionStatus: 'active',
    }, 1_789_000_000);
    expect(s.strike).toBe(2300);
    expect(s.premiumPaid).toBeCloseTo(12.081192, 6);
    expect(s.contracts).toBe(1);
    expect(s.status).toBe('active');
  });

  it('computes days to expiry from the passed clock, not wall time', () => {
    const s = shapeProtection(
      { id: '2', option: { strikes: ['230000000000'], expiry: 1_789_086_400 }, optionStatus: 'active' },
      1_789_000_000
    );
    expect(s.daysToExpiry).toBeCloseTo(1, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/positions-shape.test.ts`
Expected: FAIL — cannot resolve `../src/positions.js`.

- [ ] **Step 3: Create the module**

Move `normalizeHash`, `toNum`, `BASESCAN_TX`, and `shapeProtection` verbatim out of `app/api/positions/route.ts` into `src/positions.ts`, exporting `normalizeHash` and `shapeProtection`. Preserve every existing comment — they record on-chain findings (the bare-hash discovery, the `entryPrice` scaling) that must not be lost.

Import the two decimal constants from `src/core.js` as **type-free value imports** — `STRIKE_DECIMALS` and `USDC_DECIMALS` are plain numbers, but importing them from `core.ts` pulls in the SDK. Redeclare them locally instead so this module stays pure:

```ts
// src/positions.ts
/**
 * Position shaping, extracted from app/api/positions/route.ts so the route,
 * the list_positions tool, and the watcher share ONE definition.
 *
 * Decimal constants are redeclared rather than imported from core.ts: a value
 * import of core.ts pulls dotenv and the Thetanuts SDK into this module, and
 * this module must stay unit-testable with no network (HANDOFF.md rule 1).
 * They are asserted against core.ts's values in tests/positions-shape.test.ts.
 */
const STRIKE_DECIMALS = 8;
const USDC_DECIMALS = 6;

export type ShapedPosition = {
  id: string;
  optionAddress: string | null;
  underlying: string | null;
  strike: number | null;
  contracts: number | null;
  premiumPaid: number | null;
  collateralAmount: number | null;
  collateralSymbol: string | null;
  pnlUsd: number | null;
  status: string | null;
  exercised: boolean | null;
  entryTimestamp: number | null;
  entryTxHash: string | null;
  entryExplorer: string | null;
  expiryTimestamp: number | null;
  /** Days from the caller's clock to expiry. Negative once expired. */
  daysToExpiry: number | null;
};
```

Add `daysToExpiry` to the returned object:

```ts
    daysToExpiry: expirySec ? (expirySec - nowSec) / 86_400 : null,
```

- [ ] **Step 4: Guard the redeclared constants**

Append to `tests/positions-shape.test.ts`:

```ts
import { STRIKE_DECIMALS, USDC_DECIMALS } from '../src/core.js';

describe('decimal constants stay in sync with core.ts', () => {
  it('matches the values positions.ts redeclares', () => {
    expect(STRIKE_DECIMALS).toBe(8);
    expect(USDC_DECIMALS).toBe(6);
  });
});
```

> This is the one place a test imports `core.ts`. It reads two numeric constants and calls nothing, so it makes no network request. If this import ever causes a test-time SDK failure, replace it with a source-text assertion rather than deleting the check.

- [ ] **Step 5: Update the route to import**

In `app/api/positions/route.ts`, delete the moved functions and import them:

```ts
import { shapeProtection } from '@/src/positions';
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS. Then `npm run web` and load `/api/positions?address=<burner>` — the response shape must be unchanged apart from the new `daysToExpiry` field.

- [ ] **Step 7: Commit**

```bash
git add src/positions.ts app/api/positions/route.ts tests/positions-shape.test.ts
git commit -m "refactor: extract position shaping for reuse by tools and watcher"
```

---

### Task 8: The tool registry

**Files:**
- Create: `src/tools.ts`
- Test: `tests/tools-contract.test.ts`

**Interfaces:**
- Consumes: `core.ts` (`findCandidates`, `quote`, `payoffCurve`, `simulate`, `coverageChoice`), `judgeQuote`, `fetchSpot`, `shapeProtection`
- Produces: `ToolResult`, `ToolDef`, `ToolContext`, `TOOLS`, `toolByName(name)`, `openAiToolSchemas()`

- [ ] **Step 1: Write the failing contract test**

This test asserts registry *invariants* without touching the network — it never calls `run`.

```ts
// tests/tools-contract.test.ts
import { describe, it, expect } from 'vitest';
import { TOOLS, openAiToolSchemas, toolByName } from '../src/tools.js';

describe('tool registry contract', () => {
  it('gives every tool a unique name', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('declares a JSON Schema object for every tool', () => {
    for (const t of TOOLS) {
      expect(t.parameters).toBeTypeOf('object');
      expect((t.parameters as any).type).toBe('object');
    }
  });

  it('marks exactly the fund-touching tools as not read-only', () => {
    const writers = TOOLS.filter((t) => !t.readOnly).map((t) => t.name).sort();
    expect(writers).toEqual(['propose_execution', 'simulate_fill']);
  });

  it('exposes no tool that executes a fill', () => {
    expect(TOOLS.some((t) => /^execute/.test(t.name))).toBe(false);
  });

  it('emits OpenAI-shaped schemas for every tool', () => {
    const schemas = openAiToolSchemas();
    expect(schemas).toHaveLength(TOOLS.length);
    expect(schemas[0]).toHaveProperty('type', 'function');
    expect(schemas[0].function).toHaveProperty('name');
    expect(schemas[0].function).toHaveProperty('parameters');
  });

  it('resolves tools by name and returns undefined for unknown ones', () => {
    expect(toolByName('get_spot')?.name).toBe('get_spot');
    expect(toolByName('drop_tables')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools-contract.test.ts`
Expected: FAIL — cannot resolve `../src/tools.js`.

- [ ] **Step 3: Implement the registry**

```ts
// src/tools.ts
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
} from './core.js';
import { judgeQuote } from './judgment.js';
import { fetchSpot } from './spot.js';
import { shapeProtection } from './positions.js';
import { candidateId, toWire } from './api-shared.js';

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
          ...wire.flatMap((w) => nums(w.strike, w.daysToExpiry, w.pricePerContract, w.coverageGapDays, w.makerBudget, w.impliedStrike, w.pctFromImpliedStrike)),
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
      // Mirror the exact indexer call app/api/positions/route.ts already makes.
      const res: any = await client.positions.list({ address });
      const rows: any[] = res?.positions ?? res?.data ?? res ?? [];
      const shaped = rows.map((p) => shapeProtection(p, nowSec));
      return {
        ok: true,
        data: shaped,
        numbers: shaped.flatMap((p) => nums(p.strike, p.contracts, p.premiumPaid, p.daysToExpiry, p.pnlUsd)),
      };
    },
  },
  {
    name: 'simulate_fill',
    description:
      'Free dry run of the exact fill against current chain state (callStaticFillOrder). ' +
      'Costs nothing and moves no funds, but requires a signer address.',
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
      const r: any = await simulate(c, spendUsd);
      return { ok: true, data: r, numbers: nums(r?.contracts, r?.premiumUsdc) };
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools-contract.test.ts`
Expected: PASS (6 tests).

> If this test fails at import time because vitest cannot load the SDK, the contract test must be moved behind a dynamic `await import()` inside each test body. Do not weaken the assertions.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/tools-contract.test.ts
git commit -m "feat: transport-agnostic tool registry over core.ts

One definition for the agent loop, the watcher, and the MCP adapter. Each
tool declares the numbers it returned, which is the grounding allowlist."
```

---

# Phase 2b — Grounding guard and agent loop

### Task 9: Extract numbers from prose

**Files:**
- Create: `src/grounding.ts`
- Test: `tests/grounding-extract.test.ts`

**Interfaces:**
- Produces: `NumberToken` type, `maskNonNumeric(text): string`, `extractNumbers(text): NumberToken[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/grounding-extract.test.ts
import { describe, it, expect } from 'vitest';
import { extractNumbers } from '../src/grounding.js';

const values = (t: string) => extractNumbers(t).map((n) => n.value);

describe('extractNumbers', () => {
  it('reads currency, decimals and percentages', () => {
    expect(values('Premium is $17.45, about 3.2% of your floor.')).toEqual([17.45, 3.2]);
  });

  it('reads thousands separators as one number', () => {
    expect(values('Your floor is $2,300 on a $1,234.56 position.')).toEqual([2300, 1234.56]);
  });

  it('ignores ISO dates so calendar parts are not treated as claims', () => {
    expect(values('It expires 2026-09-11.')).toEqual([]);
  });

  it('ignores hex hashes and addresses', () => {
    expect(values('See 0xc15c6710abcdef0123 for the fill.')).toEqual([]);
  });

  it('reads a multiplier', () => {
    expect(values('That is 2.1x cheaper.')).toEqual([2.1]);
  });

  it('records the raw token so decimal precision survives', () => {
    const toks = extractNumbers('You paid $12.08.');
    expect(toks[0].raw).toBe('12.08');
    expect(toks[0].value).toBe(12.08);
  });

  it('returns nothing for prose with no digits', () => {
    expect(values('Your protection covers the full two weeks.')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/grounding-extract.test.ts`
Expected: FAIL — cannot resolve `../src/grounding.js`.

- [ ] **Step 3: Implement**

```ts
// src/grounding.ts
/**
 * The numeric grounding guard.
 *
 * Payung's headline claim is that the LLM never generates a number the user
 * sees. Before the agent loop that was true by construction: the model emitted
 * four transcribed fields and nothing else. Chat prose contains numbers, so the
 * claim survives only if it is ENFORCED. This module is that enforcement, and
 * it turns an asserted property into a demonstrable one.
 *
 * Pure. No I/O, no model, no SDK.
 */

export type NumberToken = { raw: string; value: number; index: number };

/**
 * Blank out spans whose digits are not numeric claims, before extraction.
 *
 * ISO dates and hex hashes both contain digit runs that would otherwise be read
 * as fabricated figures ("2026-09-11" -> 2026, 9, 11). Both are copied verbatim
 * from tool data and carry no arithmetic meaning. Replacing them with spaces
 * (not deleting) keeps every surviving token's index accurate.
 */
export function maskNonNumeric(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]+/g, (m) => ' '.repeat(m.length))
    .replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, (m) => ' '.repeat(m.length));
}

/** Numbers with optional thousands separators and an optional decimal part. */
const NUMBER_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

export function extractNumbers(text: string): NumberToken[] {
  const masked = maskNonNumeric(text);
  const out: NumberToken[] = [];
  for (const m of masked.matchAll(NUMBER_PATTERN)) {
    const raw = m[0].replace(/,/g, '');
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value)) out.push({ raw, value, index: m.index ?? 0 });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/grounding-extract.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/grounding.ts tests/grounding-extract.test.ts
git commit -m "feat: extract numeric claims from model prose"
```

---

### Task 10: Check numbers against the allowlist

**Files:**
- Modify: `src/grounding.ts`
- Test: `tests/grounding-check.test.ts`

**Interfaces:**
- Consumes: `extractNumbers`
- Produces: `isGrounded(tok, allowed): boolean`, `checkGrounding(text, allowed): { ok, ungrounded }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/grounding-check.test.ts
import { describe, it, expect } from 'vitest';
import { checkGrounding, isGrounded } from '../src/grounding.js';

describe('isGrounded', () => {
  it('accepts a value rounded to the precision the model wrote', () => {
    expect(isGrounded({ raw: '12.08', value: 12.08, index: 0 }, [12.081192])).toBe(true);
  });

  it('accepts a coarser rounding of the same value', () => {
    expect(isGrounded({ raw: '12.1', value: 12.1, index: 0 }, [12.081192])).toBe(true);
  });

  it('accepts an exact integer', () => {
    expect(isGrounded({ raw: '2300', value: 2300, index: 0 }, [2300])).toBe(true);
  });

  it('rejects a plausible number that no tool returned', () => {
    expect(isGrounded({ raw: '15', value: 15, index: 0 }, [12.081192])).toBe(false);
  });

  it('rejects false precision beyond what the source supports', () => {
    // The source is 12.08 exactly; claiming 12.0812 invents digits.
    expect(isGrounded({ raw: '12.0812', value: 12.0812, index: 0 }, [12.08])).toBe(false);
  });
});

describe('checkGrounding', () => {
  it('passes prose whose every number came from a tool', () => {
    const r = checkGrounding('The premium is $17.45 for a $2,300 floor.', [17.45, 2300]);
    expect(r.ok).toBe(true);
    expect(r.ungrounded).toEqual([]);
  });

  it('flags the invented number and names it', () => {
    const r = checkGrounding('The premium is $17.45 and ETH will hit $4,000.', [17.45]);
    expect(r.ok).toBe(false);
    expect(r.ungrounded.map((t) => t.value)).toEqual([4000]);
  });

  it('passes prose with no numbers at all', () => {
    expect(checkGrounding('Nothing on the book covers your deadline.', []).ok).toBe(true);
  });

  it('accepts a number from an earlier tool call in the same turn', () => {
    // The allowlist accumulates across a turn, so an earlier spot read stays valid.
    const r = checkGrounding('Spot was $2,410 when I checked, and the premium is $17.45.', [2410, 17.45]);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/grounding-check.test.ts`
Expected: FAIL — `checkGrounding is not a function`.

- [ ] **Step 3: Implement**

Append to `src/grounding.ts`:

```ts
function decimalsOf(raw: string): number {
  const dot = raw.indexOf('.');
  return dot === -1 ? 0 : raw.length - dot - 1;
}

/**
 * A token is grounded if some allowed value, rounded to the precision the model
 * actually wrote, equals it.
 *
 * This admits legitimate rounding (12.081192 written as "$12.08") while
 * rejecting both invention ("$15") and false precision ("12.0812" from a source
 * of 12.08). Precision is taken from the model's own token, so the model cannot
 * widen the tolerance by writing more digits.
 */
export function isGrounded(tok: NumberToken, allowed: number[]): boolean {
  const d = decimalsOf(tok.raw);
  return allowed.some((v) => Number(v.toFixed(d)) === tok.value);
}

export function checkGrounding(
  text: string, allowed: number[]
): { ok: boolean; ungrounded: NumberToken[] } {
  const ungrounded = extractNumbers(text).filter((t) => !isGrounded(t, allowed));
  return { ok: ungrounded.length === 0, ungrounded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/grounding-check.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/grounding.ts tests/grounding-check.test.ts
git commit -m "feat: reject model prose containing ungrounded numbers"
```

---

### Task 11: Chat transport

Separates the network from the loop, so Task 12's loop is testable with a fake.

**Files:**
- Create: `src/chat.ts`
- Test: none (pure transport; covered through the loop's fake in Task 12)

**Interfaces:**
- Produces: `ChatMessage`, `ToolCall`, `ChatResponse`, `ChatClient`, `gonkaChat(): ChatClient`

- [ ] **Step 1: Implement the transport**

```ts
// src/chat.ts
/**
 * Tool-calling chat transport. Kept separate from agent.ts so the loop can be
 * unit-tested against a scripted fake with no network.
 *
 * Verified against Gonka Router with deepseek-ai/DeepSeek-V4-Flash-0731: the
 * endpoint returns finish_reason "tool_calls" with a well-formed tool_calls
 * array, so no ReAct-style JSON fallback is needed.
 */
export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ChatResponse = { content: string | null; toolCalls: ToolCall[] };

export type ChatClient = (messages: ChatMessage[], tools: unknown[]) => Promise<ChatResponse>;

export function gonkaChat(): ChatClient {
  const base = process.env.GONKA_BASE_URL ?? 'https://api.gonkarouter.io/v1';
  const key = process.env.GONKA_API_KEY;
  const model = process.env.GONKA_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash-0731';
  if (!key) throw new Error('GONKA_API_KEY missing in .env — see .env.example.');

  return async (messages, tools) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0, messages, tools, tool_choice: 'auto' }),
    });
    if (!res.ok) throw new Error(`Gonka Router ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    const msg = json.choices?.[0]?.message ?? {};
    return { content: msg.content ?? null, toolCalls: msg.tool_calls ?? [] };
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/chat.ts
git commit -m "feat: tool-calling chat transport for Gonka Router"
```

---

### Task 12: The agent loop

**Files:**
- Create: `src/agent.ts`
- Test: `tests/agent-loop.test.ts`

**Interfaces:**
- Consumes: `ChatClient`, `ChatMessage` from `src/chat.js`; `checkGrounding` from `src/grounding.js`; `ToolDef` from `src/tools.js`
- Produces: `AgentState`, `newAgentState()`, `SYSTEM_PROMPT`, `runAgentTurn(state, userText, chat, tools): Promise<AgentState>`, `MAX_ROUNDS`

> The loop takes `tools` as a **parameter** rather than importing `TOOLS`, so the test can inject fakes and never load the SDK.

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent-loop.test.ts
import { describe, it, expect } from 'vitest';
import { newAgentState, runAgentTurn, MAX_ROUNDS } from '../src/agent.js';
import type { ChatClient } from '../src/chat.js';
import type { ToolDef } from '../src/tools.js';

const fakeTools: ToolDef[] = [
  {
    name: 'get_spot',
    description: 'spot',
    readOnly: true,
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      return { ok: true, data: { price: 2410.5 }, numbers: [2410.5] };
    },
  },
];

/** Scripts a sequence of model responses, one per call. */
function scripted(responses: { content: string | null; toolCalls?: any[] }[]): ChatClient {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return { content: r.content, toolCalls: (r.toolCalls ?? []) as any };
  };
}

const call = (name: string) => [{
  id: 't1', type: 'function' as const, function: { name, arguments: '{}' },
}];

describe('runAgentTurn', () => {
  it('runs a tool call and surfaces grounded prose', async () => {
    const chat = scripted([
      { content: null, toolCalls: call('get_spot') },
      { content: 'ETH is at $2,410.50 right now.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'what is eth at?', chat, fakeTools);
    expect(s.reply).toBe('ETH is at $2,410.50 right now.');
    expect(s.allowedNumbers).toContain(2410.5);
    expect(s.violations).toHaveLength(0);
  });

  it('adds the user’s own stated numbers to the allowlist', async () => {
    const chat = scripted([{ content: 'You said 1 ETH and a $2,300 floor.' }]);
    const s = await runAgentTurn(newAgentState(), 'I have 1 ETH and need $2,300', chat, fakeTools);
    expect(s.reply).toContain('2,300');
    expect(s.violations).toHaveLength(0);
  });

  it('retries once when prose contains an invented number', async () => {
    const chat = scripted([
      { content: null, toolCalls: call('get_spot') },
      { content: 'ETH is $2,410.50 and heading to $4,000.' },
      { content: 'ETH is $2,410.50.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'eth?', chat, fakeTools);
    expect(s.reply).toBe('ETH is $2,410.50.');
    expect(s.violations).toHaveLength(1);
    expect(s.violations[0].tokens).toContain(4000);
  });

  it('falls back deterministically when the retry is also ungrounded', async () => {
    const chat = scripted([
      { content: null, toolCalls: call('get_spot') },
      { content: 'ETH will hit $4,000.' },
      { content: 'Definitely $5,000.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'eth?', chat, fakeTools);
    expect(s.reply).not.toContain('4,000');
    expect(s.reply).not.toContain('5,000');
    expect(s.reply).toContain('could not');
    expect(s.violations).toHaveLength(2);
  });

  it('reports a tool error back to the model instead of throwing', async () => {
    const failing: ToolDef[] = [{
      ...fakeTools[0],
      async run() { return { ok: false, error: 'feed unavailable' }; },
    }];
    const chat = scripted([
      { content: null, toolCalls: call('get_spot') },
      { content: 'I could not read the price feed just now.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'eth?', chat, failing);
    expect(s.reply).toContain('could not read');
  });

  it('rejects an unknown tool name without crashing', async () => {
    const chat = scripted([
      { content: null, toolCalls: call('drop_tables') },
      { content: 'I do not have that ability.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'hi', chat, fakeTools);
    expect(s.reply).toContain('do not have');
  });

  it('stops at the round bound instead of looping forever', async () => {
    const chat = scripted([{ content: null, toolCalls: call('get_spot') }]);
    const s = await runAgentTurn(newAgentState(), 'loop', chat, fakeTools);
    expect(s.reply).toContain('could not');
    expect(s.rounds).toBe(MAX_ROUNDS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent-loop.test.ts`
Expected: FAIL — cannot resolve `../src/agent.js`.

- [ ] **Step 3: Implement**

```ts
// src/agent.ts
/**
 * The bounded agent loop.
 *
 * The model decides WHICH action to take next; it never computes a value. Every
 * number reaching the user comes from a tool's declared `numbers` array and is
 * checked by the grounding guard before it is surfaced.
 *
 * Tools are injected rather than imported so this module — and its tests — stay
 * free of the SDK.
 */
import type { ChatClient, ChatMessage } from './chat.js';
import { checkGrounding, extractNumbers } from './grounding.js';
import type { ToolDef, ToolContext } from './tools.js';

export const MAX_ROUNDS = 8;

export const SYSTEM_PROMPT = `You are Payung, an agent that helps someone put a price floor under crypto they already hold, using real put options on the live Thetanuts orderbook on Base mainnet.

HARD RULES:
- You may NOT do arithmetic. Never add, subtract, multiply, divide, or estimate.
- Every number you write must have come back from a tool call in this conversation, or have been stated by the user. If you need a number you do not have, call a tool.
- Never predict a price or offer a market view. You have no edge and it is not your job.
- If find_protection returns nothing, say so plainly and offer to loosen ONE constraint (a lower floor, or a different deadline). Never substitute a different option and describe it as what they asked for.
- If an option expires before the user's deadline, say how many days short it is before discussing anything else about it.
- propose_execution is your only terminal action, and it only prepares a transaction for the user to sign themselves. You cannot spend their money.

Be brief and concrete. Talk about dollars and dates, not options jargon.`;

export type Violation = { attempt: number; tokens: number[]; text: string };

export type AgentState = {
  messages: ChatMessage[];
  allowedNumbers: number[];
  ctx: ToolContext;
  reply: string;
  violations: Violation[];
  rounds: number;
};

export function newAgentState(): AgentState {
  return {
    messages: [{ role: 'system', content: SYSTEM_PROMPT }],
    allowedNumbers: [],
    ctx: { candidates: new Map(), spec: null, signerAddress: null },
    reply: '',
    violations: [],
    rounds: 0,
  };
}

const FALLBACK =
  'I could not put together an answer I can stand behind from live data just now. ' +
  'Try asking again, or use the form to pick a floor directly.';

export async function runAgentTurn(
  state: AgentState,
  userText: string,
  chat: ChatClient,
  tools: ToolDef[]
): Promise<AgentState> {
  const s: AgentState = { ...state, reply: '', violations: [], rounds: 0 };
  s.messages = [...state.messages, { role: 'user', content: userText }];

  // The user's own stated figures are legitimate to echo back.
  s.allowedNumbers = [...state.allowedNumbers, ...extractNumbers(userText).map((t) => t.value)];

  const schemas = tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    s.rounds = round + 1;
    const res = await chat(s.messages, schemas);

    if (res.toolCalls.length > 0) {
      s.messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls });
      for (const tc of res.toolCalls) {
        const tool = tools.find((t) => t.name === tc.function.name);
        let payload: string;
        if (!tool) {
          payload = JSON.stringify({ ok: false, error: `No such tool: ${tc.function.name}` });
        } else {
          let args: any = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }
          let result;
          try {
            result = await tool.run(args, s.ctx);
          } catch (e: any) {
            result = { ok: false as const, error: e?.shortMessage || e?.message || String(e) };
          }
          if (result.ok) s.allowedNumbers.push(...result.numbers);
          payload = JSON.stringify(result.ok ? result.data : { error: result.error });
        }
        s.messages.push({ role: 'tool', tool_call_id: tc.id, content: payload });
      }
      continue;
    }

    const text = res.content ?? '';
    const check = checkGrounding(text, s.allowedNumbers);
    if (check.ok) {
      s.messages.push({ role: 'assistant', content: text });
      s.reply = text;
      return s;
    }

    // Ungrounded. Record it, tell the model exactly which tokens it invented,
    // and allow exactly one correction before falling back.
    s.violations.push({
      attempt: s.violations.length + 1,
      tokens: check.ungrounded.map((t) => t.value),
      text,
    });
    if (s.violations.length >= 2) {
      s.reply = FALLBACK;
      return s;
    }
    s.messages.push({ role: 'assistant', content: text });
    s.messages.push({
      role: 'user',
      content:
        `These numbers did not come from any tool call: ${check.ungrounded.map((t) => t.raw).join(', ')}. ` +
        `Rewrite your answer using only numbers a tool returned, or call a tool to get them. Do not apologise.`,
    });
  }

  s.reply = FALLBACK;
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent-loop.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts tests/agent-loop.test.ts
git commit -m "feat: bounded tool-calling agent loop with enforced grounding

The model chooses which action to take next; it never computes a value.
Ungrounded prose is regenerated once, then replaced deterministically."
```

---

### Task 13: Agent surfaces — CLI and web

**Files:**
- Modify: `src/cli.ts` (add `agent` command)
- Create: `app/api/agent/route.ts`
- Modify: `app/_markup.ts` (chat pane), `public/app.js` (pane wiring), `package.json` (script)

**Interfaces:**
- Consumes: `runAgentTurn`, `newAgentState` from `src/agent.js`; `TOOLS` from `src/tools.js`; `gonkaChat` from `src/chat.js`
- Produces: `npm run agent`, `POST /api/agent`

> The existing pipeline is untouched. It remains the reliable banked-demo path.

- [ ] **Step 1: Add the CLI command**

In `src/cli.ts`, add an `agent` case following the existing command style:

```ts
    case 'agent': {
      const { newAgentState, runAgentTurn } = await import('./agent.js');
      const { gonkaChat } = await import('./chat.js');
      const { TOOLS } = await import('./tools.js');
      const readline = await import('node:readline/promises');

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const chat = gonkaChat();
      let state = newAgentState();
      // Simulation needs an address; reuse the burner's if one is configured.
      try {
        const { signerFromEnv, readClient } = await import('./core.js');
        state.ctx.signerAddress = signerFromEnv(readClient().provider).address;
      } catch {
        // No key configured — simulate_fill will decline politely. Not fatal.
      }

      console.log('Payung agent. Say what you are afraid of losing. Ctrl-C to quit.\n');
      for (;;) {
        const line = (await rl.question('> ')).trim();
        if (!line) continue;
        state = await runAgentTurn(state, line, chat, TOOLS);
        console.log(`\n${state.reply}\n`);
        for (const v of state.violations) {
          console.log(`  [guard] blocked ungrounded numbers: ${v.tokens.join(', ')}`);
        }
      }
    }
```

- [ ] **Step 2: Add the script**

In `package.json` scripts: `"agent": "tsx src/cli.ts agent",`

- [ ] **Step 3: Verify the CLI against live data**

Run: `npm run agent`, then type `I have 1 ETH and need it worth at least $2,300 in two weeks`.
Expected: the agent calls `find_protection`, then answers with real strikes and premiums. If it invents a number, the guard line prints and the answer is corrected — that is the guard working, not a bug.

- [ ] **Step 4: Add the HTTP route**

```ts
// app/api/agent/route.ts
import type { NextRequest } from 'next/server';
import { newAgentState, runAgentTurn, type AgentState } from '@/src/agent';
import { gonkaChat } from '@/src/chat';
import { TOOLS } from '@/src/tools';
import { jsonResponse, requireJsonContentType, withErrorHandling } from '@/src/api-shared';

/**
 * Conversation state lives in memory, keyed by a client-supplied id. This is a
 * hackathon-scoped store: it is per-process and evaporates on redeploy, which
 * is acceptable because a dropped conversation costs the user nothing — no
 * funds move through this route. propose_execution returns a proposal that the
 * user still signs in their own wallet.
 */
const sessions = new Map<string, AgentState>();
const MAX_SESSIONS = 200;

export async function POST(req: NextRequest) {
  const bad = requireJsonContentType(req);
  if (bad) return bad;

  return withErrorHandling(async () => {
    const body = await req.json();
    const text = String(body?.text ?? '').trim();
    const sessionId = String(body?.sessionId ?? '');
    if (!text) return jsonResponse(400, { error: 'text is required' });
    if (!sessionId) return jsonResponse(400, { error: 'sessionId is required' });

    if (sessions.size > MAX_SESSIONS) sessions.clear();

    const prior = sessions.get(sessionId) ?? newAgentState();
    if (typeof body?.signerAddress === 'string') prior.ctx.signerAddress = body.signerAddress;

    const next = await runAgentTurn(prior, text, gonkaChat(), TOOLS);
    sessions.set(sessionId, next);

    return jsonResponse(200, {
      reply: next.reply,
      // Surfaced deliberately: a guard that visibly fires is stronger evidence
      // than one that never does.
      guardBlocked: next.violations.map((v) => v.tokens),
      rounds: next.rounds,
    });
  });
}
```

- [ ] **Step 5: Add the chat pane markup**

In `app/_markup.ts`, add a section beside the existing flow:

```html
<section id="agentPane" style="margin-top: 28px; border: 1px solid var(--green-border); border-radius: var(--radius-sm); padding: 16px;">
  <span class="flow-label">ASK THE AGENT</span>
  <div id="agentLog" style="display: flex; flex-direction: column; gap: 10px; margin: 12px 0; max-height: 320px; overflow-y: auto;"></div>
  <form id="agentForm" style="display: flex; gap: 8px;">
    <input id="agentInput" type="text" autocomplete="off"
           placeholder="I have 1 ETH and need it worth at least $2,300 in two weeks"
           style="flex: 1; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--input-bg); border: 1px solid var(--green-border); color: inherit;" />
    <button type="submit" class="btn">Ask</button>
  </form>
  <p style="margin: 10px 0 0; font-size: 12.5px; color: oklch(0.7 0.01 78);">
    Every figure the agent states is checked against live tool output before you see it.
  </p>
</section>
```

- [ ] **Step 6: Wire the pane**

In `public/app.js`:

```js
// Agent pane. Independent of the main pipeline: if this errors, the fixed flow
// above is unaffected.
const agentSessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function appendAgentLine(who, text, tone) {
  const el = document.createElement('div');
  el.style.cssText = `font-size:13.5px; line-height:1.55; color:${tone || 'inherit'};`;
  el.innerHTML = `<b>${who}</b> ${text}`;
  document.getElementById('agentLog').appendChild(el);
  el.scrollIntoView({ block: 'nearest' });
}

document.getElementById('agentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('agentInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendAgentLine('You', text);
  appendAgentLine('Payung', 'thinking…', 'oklch(0.7 0.01 78)');
  const thinking = document.getElementById('agentLog').lastChild;

  try {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, sessionId: agentSessionId, signerAddress: state.address || null }),
    });
    const data = await res.json();
    thinking.remove();
    appendAgentLine('Payung', data.reply || data.error || 'No answer.');
    if (data.guardBlocked && data.guardBlocked.length) {
      appendAgentLine('Guard', `blocked ungrounded numbers: ${data.guardBlocked.flat().join(', ')}`, 'var(--amber, oklch(0.8 0.12 80))');
    }
  } catch (err) {
    thinking.remove();
    appendAgentLine('Payung', `Could not reach the agent: ${err.message}`, 'oklch(0.7 0.1 30)');
  }
});
```

Use whatever field `public/app.js` already holds the connected wallet address in; if none exists, pass `null`.

- [ ] **Step 7: Verify in the browser**

Run: `npm run web`. Ask the same sentence in the pane.
Expected: a grounded answer naming real strikes and premiums; the existing pipeline still works untouched.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts app/api/agent/route.ts app/_markup.ts public/app.js package.json
git commit -m "feat: agent surfaces — npm run agent and a web chat pane

Added alongside the fixed pipeline, which stays the reliable demo path."
```

---

# Phase 3 — The re-hedge watcher

### Task 14: Commitment store

The chain records the option. It does not record the deadline the user stated — and that deadline is exactly what makes an expiring position a problem.

**Files:**
- Create: `src/commitments.ts`
- Test: `tests/commitments.test.ts`

**Interfaces:**
- Produces: `Commitment` type, `commitmentFor(spec, txHash, optionAddress, strike, expiryIso, contracts, now): Commitment`, `deadlineDaysLeft(c, now): number`, `readCommitments(dir?)`, `writeCommitment(c, dir?)`

- [ ] **Step 1: Write the failing test**

```ts
// tests/commitments.test.ts
import { describe, it, expect } from 'vitest';
import { commitmentFor, deadlineDaysLeft } from '../src/commitments.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

describe('commitmentFor', () => {
  it('resolves the relative horizon to an absolute date at write time', () => {
    const now = new Date('2026-08-30T00:00:00Z');
    const c = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-08T08:00:00Z', 1, now);
    expect(c.deadlineIso).toBe('2026-09-13T00:00:00.000Z');
    expect(c.rollsUsed).toBe(0);
  });
});

describe('deadlineDaysLeft', () => {
  it('counts down from the absolute deadline, not the original horizon', () => {
    const now = new Date('2026-08-30T00:00:00Z');
    const c = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-08T08:00:00Z', 1, now);
    expect(deadlineDaysLeft(c, new Date('2026-09-06T00:00:00Z'))).toBeCloseTo(7, 5);
  });

  it('goes negative once the deadline has passed', () => {
    const now = new Date('2026-08-30T00:00:00Z');
    const c = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-08T08:00:00Z', 1, now);
    expect(deadlineDaysLeft(c, new Date('2026-09-15T00:00:00Z'))).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commitments.test.ts`
Expected: FAIL — cannot resolve `../src/commitments.js`.

- [ ] **Step 3: Implement**

```ts
// src/commitments.ts
/**
 * What the user actually asked for, recorded locally against the trade.
 *
 * The chain knows the option; it does not know the DEADLINE the user stated,
 * and that deadline is the whole reason an expiring position is a problem.
 * `horizonDays` is resolved to an absolute date at write time — a relative
 * horizon is meaningless to a process that wakes up days later.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProtectionSpec } from './spec.js';

export type Commitment = {
  txHash: string;
  optionAddress: string;
  spec: ProtectionSpec;
  deadlineIso: string;
  strike: number;
  expiryIso: string;
  contracts: number;
  rollsUsed: number;
  createdAt: string;
};

const DAY_MS = 86_400_000;
export const DEFAULT_DIR = '.payung';
const FILE = 'commitments.json';

export function commitmentFor(
  spec: ProtectionSpec, txHash: string, optionAddress: string,
  strike: number, expiryIso: string, contracts: number, now: Date
): Commitment {
  return {
    txHash, optionAddress, spec, strike, expiryIso, contracts,
    deadlineIso: new Date(now.getTime() + spec.horizonDays * DAY_MS).toISOString(),
    rollsUsed: 0,
    createdAt: now.toISOString(),
  };
}

export function deadlineDaysLeft(c: Commitment, now: Date): number {
  return (new Date(c.deadlineIso).getTime() - now.getTime()) / DAY_MS;
}

export function readCommitments(dir = DEFAULT_DIR): Commitment[] {
  const path = join(dir, FILE);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

export function writeCommitment(c: Commitment, dir = DEFAULT_DIR): void {
  mkdirSync(dir, { recursive: true });
  const all = readCommitments(dir).filter((x) => x.txHash !== c.txHash);
  writeFileSync(join(dir, FILE), JSON.stringify([...all, c], null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/commitments.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Record commitments on execution**

In `src/cli.ts`'s `execute` case, after a successful fill, call `writeCommitment(commitmentFor(spec, receipt.hash, optionAddress, q.strike, q.expiry.toISOString(), q.contracts, new Date()))`. Use whatever variable names that case already binds for the receipt and quote.

- [ ] **Step 6: Backfill Position B by hand**

Task 2 executed two trades before this store existed. Add Position B's record to `.payung/commitments.json` manually, using its real tx hash, option address, strike, expiry, and the horizon originally asked for. Without it the watcher will skip the position and say so.

- [ ] **Step 7: Ignore the runtime directory**

Add `.payung/` to `.gitignore` — it holds local wallet-adjacent operational state.

- [ ] **Step 8: Commit**

```bash
git add src/commitments.ts tests/commitments.test.ts src/cli.ts .gitignore
git commit -m "feat: record the user's stated deadline against each trade"
```

---

### Task 15: `decideRoll`

The one decision function. Two modes consume it, so the safe default and the autonomous mode share a single tested path.

**Files:**
- Create: `src/policy.ts`
- Test: `tests/policy.test.ts`

**Interfaces:**
- Consumes: `ShapedPosition` from `src/positions.js`, `Commitment`/`deadlineDaysLeft` from `src/commitments.js`
- Produces: `RollPolicy`, `RollDecision`, `DEFAULT_POLICY`, `decideRoll(position, commitment, now, policy)`, `validatePolicy(p): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/policy.test.ts
import { describe, it, expect } from 'vitest';
import { decideRoll, validatePolicy, type RollPolicy } from '../src/policy.js';
import { commitmentFor } from '../src/commitments.js';
import type { ShapedPosition } from '../src/positions.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 30 };
const start = new Date('2026-08-30T00:00:00Z');
const commitment = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-05T00:00:00Z', 1, start);

const policy: RollPolicy = {
  rollWhenDaysToExpiry: 2,
  minDeadlineDaysLeft: 1,
  maxPremiumUsd: 25,
  maxRolls: 3,
  assets: ['ETH'],
};

function pos(over: Partial<ShapedPosition> = {}): ShapedPosition {
  return {
    id: '1', optionAddress: '0xopt', underlying: '0xeth', strike: 2300, contracts: 1,
    premiumPaid: 12, collateralAmount: null, collateralSymbol: 'aBasUSDC', pnlUsd: null,
    status: 'active', exercised: null, entryTimestamp: null, entryTxHash: '0xabc',
    entryExplorer: null, expiryTimestamp: null, daysToExpiry: 1.5, ...over,
  } as ShapedPosition;
}

describe('decideRoll', () => {
  it('rolls when expiry is near and the deadline is still ahead', () => {
    const d = decideRoll(pos(), commitment, new Date('2026-09-03T12:00:00Z'), policy);
    expect(d.action).toBe('roll');
  });

  it('does nothing while expiry is still far away', () => {
    const d = decideRoll(pos({ daysToExpiry: 9 }), commitment, new Date('2026-09-01T00:00:00Z'), policy);
    expect(d.action).toBe('none');
  });

  it('fires exactly at the threshold', () => {
    const d = decideRoll(pos({ daysToExpiry: 2 }), commitment, new Date('2026-09-03T00:00:00Z'), policy);
    expect(d.action).toBe('roll');
  });

  it('does nothing once the deadline itself has passed', () => {
    const d = decideRoll(pos(), commitment, new Date('2026-10-01T00:00:00Z'), policy);
    expect(d.action).toBe('none');
  });

  it('does nothing for a position that is not active', () => {
    const d = decideRoll(pos({ status: 'settled-otm' }), commitment, new Date('2026-09-03T12:00:00Z'), policy);
    expect(d.action).toBe('none');
  });

  it('BLOCKS rather than idles when the roll limit is spent', () => {
    const spent = { ...commitment, rollsUsed: 3 };
    const d = decideRoll(pos(), spent, new Date('2026-09-03T12:00:00Z'), policy);
    expect(d.action).toBe('blocked');
    expect(d.reason).toContain('roll limit');
  });

  it('BLOCKS when the asset is outside the policy allowlist', () => {
    const btc = { ...commitment, spec: { ...spec, asset: 'BTC' as const } };
    const d = decideRoll(pos(), btc, new Date('2026-09-03T12:00:00Z'), policy);
    expect(d.action).toBe('blocked');
    expect(d.reason).toContain('BTC');
  });
});

describe('validatePolicy', () => {
  it('accepts a fully specified policy', () => {
    expect(validatePolicy(policy)).toEqual([]);
  });

  it('names every missing field so --auto cannot start half-configured', () => {
    const errs = validatePolicy({ rollWhenDaysToExpiry: 2 } as any);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toContain('maxPremiumUsd');
  });

  it('rejects a non-positive spend cap', () => {
    expect(validatePolicy({ ...policy, maxPremiumUsd: 0 }).join(' ')).toContain('maxPremiumUsd');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/policy.test.ts`
Expected: FAIL — cannot resolve `../src/policy.js`.

- [ ] **Step 3: Implement**

```ts
// src/policy.ts
/**
 * The roll decision. Pure — no network, no signing, no side effects.
 *
 * One function decides; two thin modes act on it (notify by default, --auto
 * when explicitly configured). That is what lets the safe default and the
 * autonomous mode share a single tested decision path.
 *
 * Trigger scope is deliberately narrow: expiry-approaching only. Spot-relative
 * and cheaper-order triggers are out of scope (see the spec).
 */
import { deadlineDaysLeft, type Commitment } from './commitments.js';
import type { ShapedPosition } from './positions.js';

export type RollPolicy = {
  /** Roll when the position has this many days or fewer left. */
  rollWhenDaysToExpiry: number;
  /** Do not roll if the user's own deadline is this close or already passed. */
  minDeadlineDaysLeft: number;
  /** Hard cap on premium for a single roll, in USD. */
  maxPremiumUsd: number;
  /** Hard cap on rolls per commitment. */
  maxRolls: number;
  assets: ('ETH' | 'BTC')[];
};

export type RollDecision =
  | { action: 'none'; reason: string }
  | { action: 'roll'; reason: string; remainingDays: number; deadlineDaysLeft: number }
  | { action: 'blocked'; reason: string };

/** Conservative defaults for notify mode. --auto refuses to use them implicitly. */
export const DEFAULT_POLICY: RollPolicy = {
  rollWhenDaysToExpiry: 2,
  minDeadlineDaysLeft: 1,
  maxPremiumUsd: 25,
  maxRolls: 3,
  assets: ['ETH', 'BTC'],
};

export function decideRoll(
  position: ShapedPosition, commitment: Commitment, now: Date, policy: RollPolicy
): RollDecision {
  if (position.status !== 'active') {
    return { action: 'none', reason: `Position is ${position.status ?? 'unknown'}, not active.` };
  }

  const remainingDays = position.daysToExpiry ?? Infinity;
  if (remainingDays > policy.rollWhenDaysToExpiry) {
    return { action: 'none', reason: `${remainingDays.toFixed(1)}d to expiry, above the ${policy.rollWhenDaysToExpiry}d trigger.` };
  }

  const left = deadlineDaysLeft(commitment, now);
  if (left <= policy.minDeadlineDaysLeft) {
    return { action: 'none', reason: `The user's deadline is ${left.toFixed(1)}d away — protection is no longer needed.` };
  }

  // Below here a roll IS needed. Anything that stops it is 'blocked', never
  // 'none': the user must learn that action was required and policy forbade it.
  if (!policy.assets.includes(commitment.spec.asset)) {
    return { action: 'blocked', reason: `${commitment.spec.asset} is not in the policy asset allowlist.` };
  }
  if (commitment.rollsUsed >= policy.maxRolls) {
    return { action: 'blocked', reason: `Roll limit reached (${commitment.rollsUsed}/${policy.maxRolls}).` };
  }

  return {
    action: 'roll',
    reason: `${remainingDays.toFixed(1)}d to expiry but ${left.toFixed(1)}d still to the deadline.`,
    remainingDays,
    deadlineDaysLeft: left,
  };
}

/** Every field must be present and sane. --auto must never start half-configured. */
export function validatePolicy(p: Partial<RollPolicy>): string[] {
  const errs: string[] = [];
  const positive = (k: keyof RollPolicy) => {
    const v = p[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) errs.push(`${k} must be a positive number`);
  };
  positive('rollWhenDaysToExpiry');
  positive('maxPremiumUsd');
  positive('maxRolls');
  if (typeof p.minDeadlineDaysLeft !== 'number' || !Number.isFinite(p.minDeadlineDaysLeft) || p.minDeadlineDaysLeft < 0) {
    errs.push('minDeadlineDaysLeft must be zero or a positive number');
  }
  if (!Array.isArray(p.assets) || p.assets.length === 0) errs.push('assets must list at least one asset');
  return errs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/policy.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts tests/policy.test.ts
git commit -m "feat: pure roll-decision policy with blocked-vs-none distinction"
```

---

### Task 16: The watcher — notify mode

**Files:**
- Create: `src/watcher.ts`
- Modify: `src/cli.ts`, `package.json`

**Interfaces:**
- Consumes: `decideRoll`, `DEFAULT_POLICY`, `readCommitments`, `shapeProtection`, `TOOLS`
- Produces: `runWatchCycle(opts): Promise<CycleReport>`, `appendAudit(entry, dir?)`, `npm run watch`

- [ ] **Step 1: Implement the watcher**

```ts
// src/watcher.ts
/**
 * The re-hedge watcher.
 *
 * Default mode NOTIFIES: it detects, quotes a replacement, and alerts. The human
 * confirms and signs. --auto executes within declared limits.
 *
 * Runs locally against the burner wallet only. It is never deployed to Vercel,
 * and serverSigningAllowed() is untouched by this module.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readCommitments, deadlineDaysLeft, DEFAULT_DIR, type Commitment } from './commitments.js';
import { decideRoll, type RollDecision, type RollPolicy } from './policy.js';
import { shapeProtection, type ShapedPosition } from './positions.js';
import { readClient, findCandidates, quote, simulate, type Candidate } from './core.js';

export type AuditEntry = {
  at: string;
  positionId: string | null;
  txHash: string;
  decision: RollDecision;
  policy: RollPolicy;
  replacement?: { strike: number; expiryIso: string; premiumUsd: number } | null;
  simulated?: boolean;
  executedTxHash?: string | null;
  note?: string;
};

export function appendAudit(entry: AuditEntry, dir = DEFAULT_DIR): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'agent-log.jsonl'), `${JSON.stringify(entry)}\n`);
}

export type CycleReport = { checked: number; rolls: number; blocked: number; alerts: string[] };

async function positionsFor(address: string, nowSec: number): Promise<ShapedPosition[]> {
  const client = readClient();
  // Mirror the exact indexer call app/api/positions/route.ts already makes —
  // do not invent an SDK method name here.
  const res: any = await client.positions.list({ address });
  const rows: any[] = res?.positions ?? res?.data ?? res ?? [];
  return rows.map((p) => shapeProtection(p, nowSec));
}

/** Find the best replacement for an expiring commitment, using the same filters as everything else. */
async function findReplacement(c: Commitment, now: Date): Promise<{ candidate: Candidate; premiumUsd: number } | null> {
  const daysLeft = deadlineDaysLeft(c, now);
  if (daysLeft <= 0) return null;
  const list = await findCandidates({ ...c.spec, horizonDays: Math.ceil(daysLeft) });
  if (list.length === 0) return null;
  const best = list[0];
  const q = await quote(best, c.contracts * best.pricePerContract);
  return { candidate: best, premiumUsd: q.premiumUsdc };
}

export async function runWatchCycle(opts: {
  address: string;
  policy: RollPolicy;
  auto: boolean;
  now?: Date;
}): Promise<CycleReport> {
  const now = opts.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const commitments = readCommitments();
  const positions = await positionsFor(opts.address, nowSec);
  const report: CycleReport = { checked: 0, rolls: 0, blocked: 0, alerts: [] };

  for (const c of commitments) {
    const p = positions.find(
      (x) => x.entryTxHash === c.txHash || x.optionAddress?.toLowerCase() === c.optionAddress.toLowerCase()
    );
    if (!p) continue;
    report.checked++;

    const decision = decideRoll(p, c, now, opts.policy);
    if (decision.action === 'none') continue;

    if (decision.action === 'blocked') {
      report.blocked++;
      const msg = `Protection on ${c.spec.asset} needs rolling but policy stopped it: ${decision.reason}`;
      report.alerts.push(msg);
      appendAudit({ at: now.toISOString(), positionId: p.id, txHash: c.txHash, decision, policy: opts.policy, note: msg });
      continue;
    }

    const replacement = await findReplacement(c, now);
    if (!replacement) {
      const msg = `Protection on ${c.spec.asset} expires in ${decision.remainingDays.toFixed(1)}d and nothing on the live book can replace it.`;
      report.alerts.push(msg);
      appendAudit({ at: now.toISOString(), positionId: p.id, txHash: c.txHash, decision, policy: opts.policy, replacement: null, note: msg });
      continue;
    }

    if (replacement.premiumUsd > opts.policy.maxPremiumUsd) {
      report.blocked++;
      const msg = `A replacement exists at $${replacement.premiumUsd.toFixed(2)} but the policy cap is $${opts.policy.maxPremiumUsd.toFixed(2)}.`;
      report.alerts.push(msg);
      appendAudit({
        at: now.toISOString(), positionId: p.id, txHash: c.txHash,
        decision: { action: 'blocked', reason: msg }, policy: opts.policy,
        replacement: { strike: replacement.candidate.strike, expiryIso: replacement.candidate.expiry.toISOString(), premiumUsd: replacement.premiumUsd },
      });
      continue;
    }

    const summary =
      `Your Payung protection on ${c.spec.asset} expires in ${decision.remainingDays.toFixed(1)} days.\n` +
      `A replacement extends your floor to ${replacement.candidate.expiry.toISOString().slice(0, 10)} ` +
      `at a $${replacement.candidate.strike.toFixed(0)} floor for $${replacement.premiumUsd.toFixed(2)}.`;

    if (!opts.auto) {
      report.alerts.push(`${summary}\n  Run: npm run execute -- ${c.spec.quantity} ${c.spec.floorTotalUsd} ${Math.ceil(decision.deadlineDaysLeft)}`);
      appendAudit({
        at: now.toISOString(), positionId: p.id, txHash: c.txHash, decision, policy: opts.policy,
        replacement: { strike: replacement.candidate.strike, expiryIso: replacement.candidate.expiry.toISOString(), premiumUsd: replacement.premiumUsd },
        note: 'notify mode — awaiting human confirmation',
      });
      continue;
    }

    // --auto: simulate first, always. Never send a fill that was not dry-run.
    await simulate(replacement.candidate, replacement.premiumUsd);
    report.rolls++;
    report.alerts.push(`${summary}\n  Simulated OK. Executing under policy (max $${opts.policy.maxPremiumUsd}).`);
    appendAudit({
      at: now.toISOString(), positionId: p.id, txHash: c.txHash, decision, policy: opts.policy,
      replacement: { strike: replacement.candidate.strike, expiryIso: replacement.candidate.expiry.toISOString(), premiumUsd: replacement.premiumUsd },
      simulated: true, note: 'auto mode — execution performed by the CLI caller',
    });
  }

  return report;
}
```

- [ ] **Step 2: Add the CLI command**

In `src/cli.ts`:

```ts
    case 'watch': {
      const { runWatchCycle } = await import('./watcher.js');
      const { DEFAULT_POLICY, validatePolicy } = await import('./policy.js');
      const { signerFromEnv, readClient } = await import('./core.js');

      const auto = process.argv.includes('--auto');
      const policy = { ...DEFAULT_POLICY };
      const errs = validatePolicy(policy);
      if (auto && errs.length) {
        console.error(`--auto refuses to start: ${errs.join('; ')}`);
        process.exit(1);
      }

      const address = signerFromEnv(readClient().provider).address;
      const intervalMs = 60_000;
      console.log(`Watching ${address} — ${auto ? 'AUTO (will spend)' : 'notify only'}. Ctrl-C to stop.\n`);

      for (;;) {
        try {
          const r = await runWatchCycle({ address, policy, auto });
          const stamp = new Date().toISOString().slice(11, 19);
          console.log(`[${stamp}] checked ${r.checked}, rolls ${r.rolls}, blocked ${r.blocked}`);
          for (const a of r.alerts) console.log(`\n🔔 ${a}\n`);
        } catch (e: any) {
          console.error(`[watch] cycle failed: ${e?.shortMessage || e?.message || e}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
```

- [ ] **Step 3: Add the script**

In `package.json` scripts: `"watch": "tsx src/cli.ts watch",`

- [ ] **Step 4: Verify against the real Position B**

Run: `npm run watch`
Expected: within one cycle it reports `checked 1` for Position B. If Position B is inside the 2-day trigger, a 🔔 alert names the replacement's real strike, expiry, and premium. Confirm `.payung/agent-log.jsonl` gained a line.

> If Position B is not yet near expiry, temporarily raise `rollWhenDaysToExpiry` to confirm the path fires, then set it back. Do not leave a widened trigger committed.

- [ ] **Step 5: Commit**

```bash
git add src/watcher.ts src/cli.ts package.json
git commit -m "feat: re-hedge watcher in notify mode with an append-only audit log"
```

---

### Task 17: `--auto` execution

**Files:**
- Modify: `src/watcher.ts` (execute after simulate), `src/commitments.ts` (increment `rollsUsed`)
- Test: `tests/commitments-roll.test.ts`

**Interfaces:**
- Produces: `incrementRolls(txHash, dir?): void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/commitments-roll.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { commitmentFor, writeCommitment, readCommitments, incrementRolls } from '../src/commitments.js';

const DIR = '.payung-test';
const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

afterEach(() => rmSync(DIR, { recursive: true, force: true }));

describe('incrementRolls', () => {
  it('advances the counter the policy cap is checked against', () => {
    const c = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-08T00:00:00Z', 1, new Date('2026-08-30T00:00:00Z'));
    writeCommitment(c, DIR);
    incrementRolls('0xabc', DIR);
    incrementRolls('0xabc', DIR);
    expect(readCommitments(DIR)[0].rollsUsed).toBe(2);
  });

  it('is a no-op for an unknown hash', () => {
    const c = commitmentFor(spec, '0xabc', '0xopt', 2300, '2026-09-08T00:00:00Z', 1, new Date('2026-08-30T00:00:00Z'));
    writeCommitment(c, DIR);
    incrementRolls('0xnope', DIR);
    expect(readCommitments(DIR)[0].rollsUsed).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commitments-roll.test.ts`
Expected: FAIL — `incrementRolls is not a function`.

- [ ] **Step 3: Implement `incrementRolls`**

Append to `src/commitments.ts`:

```ts
/** Advance the counter decideRoll checks against maxRolls. No-op if unknown. */
export function incrementRolls(txHash: string, dir = DEFAULT_DIR): void {
  const all = readCommitments(dir);
  const found = all.find((c) => c.txHash === txHash);
  if (!found) return;
  found.rollsUsed += 1;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), JSON.stringify(all, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/commitments-roll.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Execute in the watcher's auto branch**

In `src/watcher.ts`, replace the auto branch's audit-only ending with a real execution:

```ts
    // --auto: simulate first, always. Never send a fill that was not dry-run.
    await simulate(replacement.candidate, replacement.premiumUsd);
    const { execute } = await import('./core.js');
    const receipt: any = await execute(replacement.candidate, replacement.premiumUsd);
    const newHash = receipt?.hash ?? receipt?.transactionHash ?? null;
    incrementRolls(c.txHash);
    report.rolls++;
    report.alerts.push(`${summary}\n  Rolled. https://basescan.org/tx/${newHash}`);
    appendAudit({
      at: now.toISOString(), positionId: p.id, txHash: c.txHash, decision, policy: opts.policy,
      replacement: { strike: replacement.candidate.strike, expiryIso: replacement.candidate.expiry.toISOString(), premiumUsd: replacement.premiumUsd },
      simulated: true, executedTxHash: newHash, note: 'auto mode — executed under policy',
    });
```

Import `incrementRolls` from `./commitments.js` at the top.

Match `execute`'s real signature in `src/core.ts` — if it takes `(candidate, usdc, client)`, pass the same two arguments used in the CLI's `execute` case.

- [ ] **Step 6: Verify with a deliberately tiny policy**

Temporarily set `maxPremiumUsd` to a value just above Position B's replacement premium and `maxRolls: 1`. Run `npm run watch -- --auto`.
Expected: one roll executes, a real BaseScan hash prints, `.payung/agent-log.jsonl` records `executedTxHash`, and a second cycle reports `blocked` with "Roll limit reached (1/1)". **Save this hash and the log line — it is the autonomy evidence for the demo.**

- [ ] **Step 7: Commit**

```bash
git add src/watcher.ts src/commitments.ts tests/commitments-roll.test.ts
git commit -m "feat: policy-bounded autonomous roll behind --auto

Simulates before every send, caps premium and roll count, and records each
action to the append-only audit log."
```

---

# Phase 4 — Progressive disclosure and settlement copy

### Task 18: Hide the jargon without removing it

**Files:**
- Modify: `app/_markup.ts`, `public/app.js:553`, `app/globals.css`

- [ ] **Step 1: Take the maker budget off the primary card**

In `public/app.js`, change the `heroDetails` assignment so the main view carries only what a non-technical user needs:

```js
  document.getElementById('heroDetails').textContent =
    `${selected.daysToExpiry.toFixed(1)}d window · expires ${selected.expiryIso.slice(0,10)}`;
```

- [ ] **Step 2: Add the disclosure block**

In `app/_markup.ts`, below the hero card:

```html
<details class="tech-details">
  <summary>On-chain details</summary>
  <dl id="techDetails">
    <dt>Settlement asset</dt><dd id="techCollateral">—</dd>
    <dt>Price source</dt><dd>Chainlink</dd>
    <dt>Maximum fill (maker collateral)</dt><dd id="techMakerBudget">—</dd>
    <dt>Network</dt><dd>Base mainnet</dd>
    <dt>Order expiry</dt><dd id="techOrderExpiry">—</dd>
  </dl>
</details>
```

- [ ] **Step 3: Populate it**

In `public/app.js`, beside the `heroDetails` assignment:

```js
  // Nothing is removed — the technical facts move behind a disclosure so the
  // payment step stops opening with aBasUSDC and maker collateral.
  document.getElementById('techCollateral').textContent = selected.collateralSymbol || 'aBasUSDC';
  document.getElementById('techMakerBudget').textContent = formatMoney(selected.makerBudget, 0);
  document.getElementById('techOrderExpiry').textContent = selected.expiryIso.slice(0, 10);
```

Add `collateralSymbol` to `toWire` in `src/api-shared.ts` if it is not already returned; the symbol is available via `tokenSymbol()` on the candidate's `collateralToken`.

- [ ] **Step 4: Style it**

In `app/globals.css`:

```css
/* Progressive disclosure: transparency without a jargon wall at the payment step. */
.tech-details { margin-top: 14px; border-top: 1px solid var(--green-border); padding-top: 12px; }
.tech-details summary {
  cursor: pointer; font-size: 12.5px; letter-spacing: 0.04em;
  text-transform: uppercase; color: oklch(0.7 0.01 78);
}
.tech-details summary:focus-visible { outline: 2px solid var(--green-border); outline-offset: 3px; }
.tech-details dl {
  display: grid; grid-template-columns: auto 1fr; gap: 6px 16px;
  margin: 12px 0 0; font-size: 13px;
}
.tech-details dt { color: oklch(0.7 0.01 78); }
.tech-details dd { margin: 0; }
```

- [ ] **Step 5: Verify**

Run: `npm run web`. Walk to the payment step.
Expected: the main view shows premium, floor, expiry, and coverage only. `aBasUSDC`, Chainlink, and the maker budget appear only after clicking `On-chain details`. The summary is reachable and toggleable by keyboard.

- [ ] **Step 6: Commit**

```bash
git add app/_markup.ts public/app.js app/globals.css src/api-shared.ts
git commit -m "feat: move on-chain jargon behind progressive disclosure"
```

---

### Task 19: Settlement copy

**Files:**
- Modify: `app/_markup.ts`, `app/history/HistoryClient.tsx`
- Consumes: `docs/settlement-findings.md` from Task 1

- [ ] **Step 1: Add the lifecycle line**

In `app/_markup.ts`, in the payoff/confirmation area:

```html
<div class="settlement-note">
  <span class="flow-label">AFTER EXPIRY</span>
  <p id="settlementBody">Expiry → Settlement → Payout</p>
</div>
```

- [ ] **Step 2: Write the copy the measurement supports**

Set `#settlementBody`'s text to exactly one of these, chosen by Task 1's conclusion. Do not blend them.

- Keeper-automatic: `Expiry → Settlement → Payout. If your floor is in the money at expiry, the payout is settled on-chain and reaches your wallet without you doing anything. Measured across <N> live settled positions, this took about <duration> after expiry.`
- Holder must act: `Expiry → Settlement → Payout. If your floor is in the money at expiry, you must claim the payout — it does not arrive on its own. Payung will show a Claim button on this position once it expires.`
- Ambiguous: `Expiry → Settlement → Payout. Settlement happens on-chain shortly after expiry. We are confirming with Thetanuts whether the payout is pushed to your wallet automatically or needs a claim; until then, check your position on BaseScan after expiry.`

- [ ] **Step 3: Surface awaiting-settlement positions**

In `app/history/HistoryClient.tsx`, render `expired-awaiting-settlement` as its own visible state rather than folding it into expired — an unclaimed payout is a worse failure than a mislabelled badge. If Task 1 concluded the holder must act, add the claim affordance here.

- [ ] **Step 4: Verify**

Run: `npm run web`, open `/history` with the burner address.
Expected: the lifecycle line appears; any awaiting-settlement position is visibly distinct from a settled one.

- [ ] **Step 5: Commit**

```bash
git add app/_markup.ts app/history/HistoryClient.tsx
git commit -m "feat: state the expiry-to-payout lifecycle from measured behaviour"
```

---

# Phase 5 — Evaluation suite *(stretch)*

### Task 20: Intent and grounding evals

**Files:**
- Create: `tests/eval/cases.json`, `tests/eval/intent-eval.test.ts`, `scripts/eval-live.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `classifyPartialSpec` from `src/intent.js`, `checkGrounding` from `src/grounding.js`

- [ ] **Step 1: Write the case file**

```json
[
  { "name": "total floor, plain",
    "raw": { "asset": "ETH", "quantity": 1, "floorValue": 2300, "floorMode": "total", "horizonDays": 14 },
    "expect": { "asset": "ETH", "quantity": 1, "floorTotalUsd": 2300, "horizonDays": 14 } },
  { "name": "per-unit floor is multiplied in code, not by the model",
    "raw": { "asset": "BTC", "quantity": 2, "floorValue": 62000, "floorMode": "perUnit", "horizonDays": 30 },
    "expect": { "asset": "BTC", "quantity": 2, "floorTotalUsd": 124000, "horizonDays": 30 } },
  { "name": "missing horizon is highlighted, not invented",
    "raw": { "asset": "ETH", "quantity": 1, "floorValue": 2300, "floorMode": "total", "horizonDays": null },
    "expectMissing": ["horizonDays"] },
  { "name": "ambiguous floor mode becomes a field error",
    "raw": { "asset": "ETH", "quantity": 1, "floorValue": 2300, "floorMode": null, "horizonDays": 14 },
    "expectFieldError": "floor" },
  { "name": "unsupported asset is a field error, not a whole-parse failure",
    "raw": { "asset": "SOL", "quantity": 10, "floorValue": 1000, "floorMode": "total", "horizonDays": 7 },
    "expectFieldError": "asset" },
  { "name": "implausible strike is rejected",
    "raw": { "asset": "ETH", "quantity": 100000000, "floorValue": 100, "floorMode": "total", "horizonDays": 7 },
    "expectFieldError": "floor" }
]
```

- [ ] **Step 2: Write the offline eval test**

```ts
// tests/eval/intent-eval.test.ts
import { describe, it, expect } from 'vitest';
import { classifyPartialSpec } from '../../src/intent.js';
import cases from './cases.json' with { type: 'json' };

describe('intent eval (offline — no network, no key)', () => {
  for (const c of cases as any[]) {
    it(c.name, () => {
      const got = classifyPartialSpec(c.raw);
      if (c.expect) {
        expect(got.asset).toBe(c.expect.asset);
        expect(got.quantity).toBe(c.expect.quantity);
        expect(got.floorTotalUsd).toBeCloseTo(c.expect.floorTotalUsd, 6);
        expect(got.horizonDays).toBe(c.expect.horizonDays);
      }
      if (c.expectMissing) expect(got.missingFields).toEqual(expect.arrayContaining(c.expectMissing));
      if (c.expectFieldError) expect(got.fieldErrors[c.expectFieldError]).toBeTruthy();
    });
  }
});
```

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/eval/intent-eval.test.ts`
Expected: PASS (6 tests). If `import ... with { type: 'json' }` is unsupported, read the file with `readFileSync` and `JSON.parse` instead.

- [ ] **Step 4: Write the live eval script**

```ts
// scripts/eval-live.ts
// Hits Gonka for real and reports a pass rate on natural-language phrasing,
// including Bahasa Malaysia — the product is named for a Malay word and its
// first users are likely to type in it.
import 'dotenv/config';
import { gonkaLlm, parsePartialIntent } from '../src/intent.js';

const SENTENCES: { text: string; asset: string; quantity: number; horizonDays: number }[] = [
  { text: 'I have 1 ETH and need it worth at least $2,300 in two weeks', asset: 'ETH', quantity: 1, horizonDays: 14 },
  { text: 'protect 2 BTC, I cannot let it fall below $62,000 each, for a month', asset: 'BTC', quantity: 2, horizonDays: 30 },
  { text: 'tuition is due end of next week, I hold 3 ETH and need $7,000 total', asset: 'ETH', quantity: 3, horizonDays: 10 },
  { text: 'Saya ada 1 ETH, saya perlu nilainya sekurang-kurangnya $2,300 dalam dua minggu', asset: 'ETH', quantity: 1, horizonDays: 14 },
  { text: 'Saya nak lindungi 2 BTC saya untuk sebulan, jangan jatuh bawah $62,000 satu', asset: 'BTC', quantity: 2, horizonDays: 30 },
];

async function main() {
  const llm = gonkaLlm();
  let pass = 0;
  for (const s of SENTENCES) {
    try {
      const got = await parsePartialIntent(s.text, llm);
      const ok = got.asset === s.asset && got.quantity === s.quantity && got.horizonDays === s.horizonDays;
      if (ok) pass++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.text}`);
      if (!ok) console.log(`      got ${JSON.stringify({ asset: got.asset, quantity: got.quantity, horizonDays: got.horizonDays })}`);
    } catch (e: any) {
      console.log(`ERROR ${s.text}\n      ${e?.message ?? e}`);
    }
  }
  console.log(`\n${pass}/${SENTENCES.length} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Add the script and run it**

In `package.json` scripts: `"eval:live": "tsx scripts/eval-live.ts",`
Run: `npm run eval:live`
Expected: a pass rate. Record it in `PROJECT.md` — a measured number is worth more to a judge than a claim of robustness.

- [ ] **Step 6: Commit**

```bash
git add tests/eval scripts/eval-live.ts package.json PROJECT.md
git commit -m "test: intent eval suite, offline in CI and live against Gonka"
```

---

# Phase 6 — MCP adapter *(stretch)*

### Task 21: Expose the registry over MCP

**Files:**
- Create: `mcp/server.ts`
- Modify: `package.json`, `README.md`

- [ ] **Step 1: Add the dependency**

Run: `npm install @modelcontextprotocol/sdk`

- [ ] **Step 2: Write the adapter**

```ts
// mcp/server.ts
/**
 * MCP adapter over Payung's own tool registry.
 *
 * Deliberately NOT built on @thetanuts-finance/mcp. That server exposes a
 * generic surface that permits WRITING options — the one thing a Payung user
 * must never do by accident. Payung's registry has already applied the
 * buyable-puts-only, correct-underlying, and dollar-collateral filters, so this
 * adapter inherits those guarantees for free.
 *
 * Because ToolDef already carries JSON Schema, this is an adapter, not a
 * reimplementation.
 */
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, toolByName, type ToolContext } from '../src/tools.js';

const ctx: ToolContext = { candidates: new Map(), spec: null, signerAddress: null };

const server = new Server(
  { name: 'payung', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
    annotations: { readOnlyHint: t.readOnly },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = toolByName(req.params.name);
  if (!tool) {
    return { isError: true, content: [{ type: 'text', text: `No such tool: ${req.params.name}` }] };
  }
  const result = await tool.run(req.params.arguments ?? {}, ctx);
  return result.ok
    ? { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] }
    : { isError: true, content: [{ type: 'text', text: result.error }] };
});

await server.connect(new StdioServerTransport());
```

- [ ] **Step 3: Add the script**

In `package.json` scripts: `"mcp": "tsx mcp/server.ts",`

- [ ] **Step 4: Verify**

Run: `npx @modelcontextprotocol/inspector npx tsx mcp/server.ts`
Expected: all tools list with correct schemas; `find_protection` returns live candidates; `propose_execution` is annotated as not read-only; no tool can execute a fill.

- [ ] **Step 5: Document it**

Add a short README section covering how to point an MCP client at Payung, and state plainly why it is not built on the Thetanuts MCP server — that reasoning is the answer to a question a judge is likely to ask.

- [ ] **Step 6: Commit**

```bash
git add mcp/server.ts package.json package-lock.json README.md
git commit -m "feat: MCP adapter over Payung's safety-constrained tool registry"
```

---

## Final verification

- [ ] `npm test` — every suite passes
- [ ] `npx tsc --noEmit` — no type errors
- [ ] `npm run web` — full pipeline works; agent pane answers with grounded numbers; no `EXACT MATCH` anywhere; jargon sits behind disclosure
- [ ] `npm run agent` — a live tool-calling conversation ends in a proposal
- [ ] `npm run watch` — reports on a real position and writes the audit log
- [ ] `README.md` proof section holds a real BaseScan URL and a real paid figure
- [ ] `.payung/agent-log.jsonl` contains at least one autonomous roll with a real tx hash
