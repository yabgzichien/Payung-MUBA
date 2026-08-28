# UX: Total-Value Floor + Unified Candlestick/Payoff Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the ambiguity between "floor as per-unit strike" and "floor as total value" that currently produces silently-wrong option matches, and add a unified candlestick + payoff chart so the product shows spot price, price history, the strike, the deadline, and the payoff curve in one picture.

**Architecture:** `ProtectionSpec` gains an explicit `quantity` field; the per-unit strike the matcher needs becomes a derived pure function (`impliedStrike`) rather than a second stored number, so the two readings can never drift. A new `src/spot.ts` module (separate from `core.ts`, since price history is not a Thetanuts concern) supplies Coinbase candle history and a Chainlink spot read through a new `GET /api/history` route. `web/index.html`'s existing hand-rolled SVG chart is replaced with a single price-vs-time chart carrying candles, strike, spot, expiry, a protected-region shade, and the existing payoff curve transposed into a right-edge gutter sharing the same price axis.

**Tech Stack:** TypeScript (ESM, `tsx`, no bundler), `ethers` v6, `@thetanuts-finance/thetanuts-client`, Vitest for pure-function tests, vanilla JS/SVG in `web/index.html` — no new dependencies added.

**Spec:** [docs/superpowers/specs/2026-08-28-ux-quantity-and-candlestick-design.md](../specs/2026-08-28-ux-quantity-and-candlestick-design.md)

## Revision — 2026-08-28, post-audit

This plan was audited against the repo, the SDK's type declarations, the live Chainlink feeds, and the live Coinbase API before execution. Its task decomposition and line-number citations held up; nine defects did not, and are fixed above. Recorded here because most of them **fail silently** — an agent executing the original text would have produced something that looked finished.

| # | Defect | Fixed in |
|---|---|---|
| 1 | `granularityFor` requested more than Coinbase's 300-candle cap, returning HTTP 400 for `days=2` and `days=76-90` — both inside the horizon field's own 1-90 range. Confirmed against the live API. | Task 8 |
| 2 | The payoff gutter mapped a `[strike*0.8, strike*1.2]` curve through a Y axis spanning only candles/strike/spot, putting its endpoints hundreds of pixels outside a 320-tall viewBox. | Task 9 |
| 3 | The far-miss warning was written into `#candVerdict`, which `selectCandidate` overwrites milliseconds later — the flagship "'closest match' is a lie" fix would never have been visible. | Task 10 |
| 4 | `Math.max(0, …)` scored every candidate at or above the implied strike as a 0% deviation, badging a strike far *above* the requested floor as a perfect match and suppressing the warning entirely. | Tasks 4, 10 |
| 5 | Moving distance server-side made it stale on edit: the debounced re-render measured badges against the *previous* implied strike with no indication. | Task 10 |
| 6 | Importing `impliedStrike` from `core.ts` into `intent.ts` would have made it a **value** import, pulling `dotenv` and the Thetanuts SDK into the zero-network intent tests and breaking `HANDOFF.md` design rule 1. | Task 1 (new `src/spec.ts`), Task 3 |
| 7 | `src/spot.ts` imported `@thetanuts-finance/thetanuts-client`, contradicting both this plan's own Global Constraints and the module's own docstring. | Tasks 7, 8 |
| 8 | Task 5 asserted no `floorUsd` reference remained in `README.md`. [README.md:33](../../../README.md#L33) documents the old spec shape, as does the comment at `src/server.ts:154`. | Task 5 |
| 9 | `fetchSpot` had no retry and the route swallowed failures to `spot: null` with a server-side log only — the public Base RPC rate-limits these reads under light load (observed directly). | Tasks 8, 9 |

Smaller corrections folded in: `impliedStrike` hoisted out of the sort comparator; `(client as any).provider` dropped (the field is public and typed); SVG presentation attributes kept as hex literals rather than `var()`, matching the existing `drawPayoff`; a render token added so overlapping history fetches can't paint a stale chart; `api2` renamed `apiGet`; the `floorTotalUsd` bound widening documented as deliberate; the client-side `impliedStrike` duplication in `restateSentence()` recorded as an explicit, bounded exception to the no-presentation-math constraint rather than justified only in a code comment; and Task 10's far-miss verification case corrected (0.32 ETH / $798 implies a floor *close* to spot post-fix — it is the regression case, not a far-miss case).

Also worth knowing: the design doc's §3.4 lists `tests/fixtures.ts` as needing an update. It contains no spec literal and needs none — the doc is wrong there, the plan is right.

## Global Constraints

- `src/core.ts` remains the only module that touches the Thetanuts SDK — `src/spot.ts` must never import `@thetanuts-finance/thetanuts-client` **in any form, not even `import type`**. It takes a feed address and an `ethers.Provider` as plain arguments instead, which also makes it unit-testable.
- `src/spec.ts` (new, Task 1) holds `ProtectionSpec` + `impliedStrike` and has **zero imports**. This exists so `src/intent.ts` can call `impliedStrike` at runtime without taking a value dependency on `core.ts`: `HANDOFF.md`'s design rule 1 requires `intent.ts`/`judgment.ts` to import only *types* from `core`, and a value import would drag `dotenv/config` and the whole Thetanuts SDK into the zero-network intent tests.
- The LLM (`src/intent.ts`) never produces a number the user sees — it only ever transcribes stated fields; no field it emits may be computed by the model (no dividing/multiplying).
- No fabricated numbers, anywhere — every price/premium/payoff/spot/candle figure traces to a live SDK call, a live Chainlink read, a live Coinbase read, or an empirical receipt read.
- Approve exact amounts, never `MaxUint256` (unaffected by this plan, but no task may weaken it).
- Base mainnet only, chainId 8453 — no testnet config.
- Every pure function (filtering, decoding, validation, candle normalization) gets a unit test with zero network access, per `tests/fixtures.ts`'s existing pattern. Live/network behavior (Coinbase fetch, Chainlink read, live book) is verified ad hoc, never inside `vitest`.
- Run `npm test` and `npx tsc --noEmit` before considering any task done. `tsc` has exactly one known pre-existing unrelated error (`src/core.ts`, `chainConfig.contracts.optionBook: string | null`) — don't let a second one join it.
- Presentation layers (`server.ts`, `cli.ts`, `web/index.html`) never compute a number `core.ts` (or the new `src/spot.ts`) could compute instead.

---

## Task 1: `ProtectionSpec` gains `quantity`, and `impliedStrike` becomes the single source of truth for the per-unit number

**Files:**
- Create: `src/spec.ts` — the `ProtectionSpec` type + `impliedStrike`, with zero imports
- Modify: `src/core.ts:136-143` — delete the local `ProtectionSpec` type; import from `./spec.js` and re-export both names
- Test: `tests/implied-strike.test.ts` (new)

**Interfaces:**
- Produces: `ProtectionSpec = { asset: 'ETH' | 'BTC'; quantity: number; floorTotalUsd: number; horizonDays: number }` (replaces the old `{asset, floorUsd, horizonDays}` shape) — defined in `src/spec.ts`, re-exported from `src/core.ts` so every existing `from './core.js'` import keeps working unchanged
- Produces: `impliedStrike(spec: ProtectionSpec): number` — pure, `spec.floorTotalUsd / spec.quantity`

**Why a separate module rather than putting this in `core.ts`:** Task 3 needs `impliedStrike` **at runtime** inside `src/intent.ts` (the implied-strike plausibility check). `intent.ts` currently imports only types from `core.ts` — `HANDOFF.md` design rule 1 mandates that — and switching to a value import would pull `dotenv/config` plus `@thetanuts-finance/thetanuts-client` into `intent.ts` and into the zero-network intent tests. A dependency-free `src/spec.ts` gives every consumer one definition of the division without that coupling. `tsconfig.json` sets neither `isolatedModules` nor `verbatimModuleSyntax`, so the plain re-export below compiles as written.

- [ ] **Step 1: Write the failing test**

Create `tests/implied-strike.test.ts`. Note it imports from `../src/spec.js`, not `../src/core.js` — this test must stay free of the SDK:

```ts
import { describe, it, expect } from 'vitest';
import { impliedStrike, type ProtectionSpec } from '../src/spec.js';

describe('impliedStrike', () => {
  it('divides total floor by quantity to get a per-unit strike', () => {
    const spec: ProtectionSpec = { asset: 'ETH', quantity: 0.32, floorTotalUsd: 798, horizonDays: 14 };
    expect(impliedStrike(spec)).toBeCloseTo(2493.75, 2);
  });

  it('is exactly the floor when quantity is 1', () => {
    const spec: ProtectionSpec = { asset: 'ETH', quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };
    expect(impliedStrike(spec)).toBe(2300);
  });

  it('produces a large implied strike for a small quantity (the $798-for-0.32-ETH regression case)', () => {
    const spec: ProtectionSpec = { asset: 'ETH', quantity: 0.01, floorTotalUsd: 798, horizonDays: 14 };
    expect(impliedStrike(spec)).toBeCloseTo(79800, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/implied-strike.test.ts`
Expected: FAIL — `src/spec.ts` does not exist yet, so the import cannot resolve.

- [ ] **Step 3a: Create `src/spec.ts`**

```ts
/**
 * The user's stated constraint, and the one derivation over it.
 *
 * This module deliberately has ZERO imports. `src/intent.ts` calls
 * `impliedStrike` at runtime, and HANDOFF.md's design rule 1 requires
 * intent.ts/judgment.ts to import only *types* from core.ts — putting this
 * in core.ts would force a value import that drags dotenv and the whole
 * Thetanuts SDK into the zero-network intent tests.
 */

export type ProtectionSpec = {
  /** 'ETH' | 'BTC' — what the user holds. */
  asset: 'ETH' | 'BTC';
  /** How much of the asset the user holds. */
  quantity: number;
  /** Total USD value the whole holding must be worth at the deadline. */
  floorTotalUsd: number;
  /** How long they need protection, in days. */
  horizonDays: number;
};

/**
 * The per-unit strike a total-value floor implies. This is the ONLY place
 * this division happens — filterCandidates, validateSpec, the CLI, and the
 * server all read this instead of recomputing it, so the per-unit and total
 * readings of a floor can never drift apart (see the design doc's Section 1a
 * regression: "$798 for 0.32 ETH" was previously matched as a $798 strike
 * instead of the correct $2,493.75).
 */
export function impliedStrike(spec: ProtectionSpec): number {
  return spec.floorTotalUsd / spec.quantity;
}
```

- [ ] **Step 3b: Re-point `src/core.ts` at it**

In `src/core.ts`, replace lines 136-143:

```ts
export type ProtectionSpec = {
  /** 'ETH' | 'BTC' — what the user holds. */
  asset: 'ETH' | 'BTC';
  /** The floor the user wants under their asset, in USD. */
  floorUsd: number;
  /** How long they need protection, in days. */
  horizonDays: number;
};
```

with a re-export, so every existing `import { ..., type ProtectionSpec } from './core.js'` across `server.ts`, `cli.ts`, and the tests keeps resolving without edits:

```ts
export type { ProtectionSpec } from './spec.js';
export { impliedStrike } from './spec.js';
```

and add `ProtectionSpec`/`impliedStrike` to core's own imports at the top of the file (core.ts uses `ProtectionSpec` in `filterCandidates`, `coverageGapDays`, and `findCandidates`, and will use `impliedStrike` in Task 2):

```ts
import { impliedStrike, type ProtectionSpec } from './spec.js';
```

Note: a re-export of a name you also import locally is fine here — `tsconfig.json` sets neither `isolatedModules` nor `verbatimModuleSyntax`. If `tsc` objects, collapse to `export { impliedStrike };` / `export type { ProtectionSpec };` after the import instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/implied-strike.test.ts`
Expected: PASS (3 tests). Note: `src/core.ts` will not fully type-check yet — `filterCandidates` still references `spec.floorUsd`, which no longer exists. That's fixed in Task 2; this step only confirms `impliedStrike` itself is correct in isolation (vitest transpiles per-file and doesn't fail on unrelated type errors elsewhere in the same file at runtime, but run `npx tsc --noEmit` now to see the expected, temporary errors so you recognize them as expected in Task 2, not a mistake here).

- [ ] **Step 5: Commit**

```bash
git add src/spec.ts src/core.ts tests/implied-strike.test.ts
git commit -m "feat: quantity-aware ProtectionSpec with derived impliedStrike in a dependency-free src/spec.ts"
```

---

## Task 2: `filterCandidates` matches on `impliedStrike`, and its tests/fixtures move to the new spec shape

**Files:**
- Modify: `src/core.ts:159-184` (`filterCandidates`)
- Modify: `tests/filter.test.ts`

**Interfaces:**
- Consumes: `impliedStrike(spec)` from Task 1
- Produces: `filterCandidates(book, spec, cfg)` unchanged in signature, now ranks by distance to `impliedStrike(spec)` instead of `spec.floorUsd`

- [ ] **Step 1: Update the failing spec fixture in the test file**

In `tests/filter.test.ts`, replace line 5:

```ts
const spec = { asset: 'ETH' as const, floorUsd: 2300, horizonDays: 14 };
```

with:

```ts
const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };
```

Also add a new test asserting ranking uses the implied strike, not the raw total, appended inside the `describe('filterCandidates', ...)` block after the existing `'keeps the 0.6x-2.5x horizon window...'` test:

```ts
  it('ranks by impliedStrike (floorTotalUsd / quantity), not the raw total', () => {
    // 2 ETH at a $4600 total floor implies a $2300/ETH strike — the same
    // ranking as the 1-ETH/$2300 spec above, even though floorTotalUsd differs.
    const twoEthSpec = { asset: 'ETH' as const, quantity: 2, floorTotalUsd: 4600, horizonDays: 14 };
    const book = [
      makeCandidate({ strike: 2100, daysToExpiry: 10 }),
      makeCandidate({ strike: 2290, daysToExpiry: 10 }),
    ];
    const out = filterCandidates(book, twoEthSpec, cfg);
    expect(out[0].strike).toBe(2290); // closest to implied 2300, not to raw 4600
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/filter.test.ts`
Expected: FAIL — `filterCandidates` still sorts by `spec.floorUsd`, which is now `undefined` on the new spec shape, so `Math.abs(a.strike - undefined)` is `NaN` and the sort order (hence `out[0].strike`) is wrong/unstable.

- [ ] **Step 3: Update `filterCandidates` to rank by `impliedStrike`**

In `src/core.ts`, inside `filterCandidates`, hoist the derivation above the chain — a comparator runs O(n log n) times and there is no reason to redo the division on every comparison. Insert immediately after the function's opening brace, before `return (`:

```ts
  // Derived once: the per-unit strike this spec's total value + quantity imply.
  const target = impliedStrike(spec);
```

then replace (around line 181):

```ts
      // Prefer strikes near the requested floor.
      .sort((a, b) => Math.abs(a.strike - spec.floorUsd) - Math.abs(b.strike - spec.floorUsd))
```

with:

```ts
      // Prefer strikes near the per-unit floor implied by the total value + quantity.
      .sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))
```

`impliedStrike` is already in scope from the `./spec.js` import added in Task 1 Step 3b.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/filter.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Run the full suite and typecheck to confirm no other pure-function tests broke**

Run: `npm test && npx tsc --noEmit`
Expected: `tests/filter.test.ts` and `tests/implied-strike.test.ts` pass. Other test files (`intent.test.ts`, `wire.test.ts`, `judgment.test.ts`, `coverage.test.ts`, etc.) may still fail or the project may still fail to typecheck at this point — those are fixed in later tasks. Confirm the *only* new failures are ones referencing `floorUsd` (they'll be fixed in Tasks 3–4), not something unrelated you broke.

- [ ] **Step 6: Commit**

```bash
git add src/core.ts tests/filter.test.ts
git commit -m "feat: filterCandidates ranks by impliedStrike instead of a raw per-unit floor"
```

---

## Task 3: `intent.ts` — LLM prompt and `validateSpec` move to `{asset, quantity, floorTotalUsd, horizonDays}`

**Files:**
- Modify: `src/intent.ts:37-41` (the `SYSTEM` prompt), `src/intent.ts:94-115` (`validateSpec`)
- Modify: `tests/intent.test.ts`

**Interfaces:**
- Consumes: `impliedStrike` + `ProtectionSpec` from **`src/spec.js`** (Task 1) — NOT from `core.js`. This is the whole reason `src/spec.ts` exists; importing the value from `core.js` here would pull `dotenv/config` and the Thetanuts SDK into this module and into `tests/intent.test.ts`, breaking `HANDOFF.md` design rule 1.
- Produces: `validateSpec(obj): ProtectionSpec` now requires `quantity` and `floorTotalUsd`; throws if `quantity` is missing/non-positive or if `impliedStrike(spec)` falls outside `[1, 10_000_000]`

**Deliberate bound change (not a typo):** `floorTotalUsd`'s upper bound widens from the old `floorUsd`'s `10_000_000` to `10_000_000_000`. A *total* holding value can legitimately exceed any plausible *per-unit* price, so reusing the per-unit ceiling would reject real inputs. The per-unit sanity check has not been loosened — it moves to the `impliedStrike` range check below, which still enforces `[1, 10_000_000]`. That is where implausible inputs are now caught.

- [ ] **Step 1: Update the failing tests first**

In `tests/intent.test.ts`, replace the whole file's spec literals and add new cases. Full replacement:

```ts
import { describe, it, expect } from 'vitest';
import { parseIntent, validateSpec } from '../src/intent.js';

const llmReturning = (s: string) => async () => s;

describe('parseIntent', () => {
  it('accepts clean JSON', async () => {
    const spec = await parseIntent('x', llmReturning('{"asset":"ETH","quantity":1,"floorTotalUsd":2300,"horizonDays":14}'));
    expect(spec).toEqual({ asset: 'ETH', quantity: 1, floorTotalUsd: 2300, horizonDays: 14 });
  });

  it('extracts JSON wrapped in prose', async () => {
    const spec = await parseIntent('x', llmReturning('Sure! {"asset":"BTC","quantity":1,"floorTotalUsd":60000,"horizonDays":30} there.'));
    expect(spec.asset).toBe('BTC');
  });

  it('rejects a non-protection request via the error field', async () => {
    await expect(parseIntent('x', llmReturning('{"error":"asked for a joke"}'))).rejects.toThrow(/Not a protection request/);
  });

  it('rejects unsupported assets', async () => {
    await expect(parseIntent('x', llmReturning('{"asset":"DOGE","quantity":1,"floorTotalUsd":1,"horizonDays":7}'))).rejects.toThrow(/Unsupported asset/);
  });

  it('rejects out-of-range horizons', async () => {
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","quantity":1,"floorTotalUsd":2300,"horizonDays":400}'))).rejects.toThrow(/1-90/);
  });

  it('rejects a missing or non-positive quantity', async () => {
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","floorTotalUsd":2300,"horizonDays":7}'))).rejects.toThrow(/quantity/i);
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","quantity":0,"floorTotalUsd":2300,"horizonDays":7}'))).rejects.toThrow(/quantity/i);
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","quantity":-1,"floorTotalUsd":2300,"horizonDays":7}'))).rejects.toThrow(/quantity/i);
  });

  it('rejects an implied strike outside the plausible range (the $798-for-0.32-ETH regression class)', async () => {
    // 1000 ETH at a $798 total floor implies a $0.80/ETH strike — implausible.
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","quantity":1000,"floorTotalUsd":798,"horizonDays":7}'))).rejects.toThrow(/implied|strike/i);
  });

  it('rejects non-JSON garbage', async () => {
    await expect(parseIntent('x', llmReturning('I cannot help with that'))).rejects.toThrow(/no JSON/);
  });

  // Regression: greedy `/\{[\s\S]*\}/` used to span from the first `{` to the
  // LAST `}` in the whole response. A nested answer like `{"result": {...}}`
  // is itself a single balanced top-level object, so it parses successfully
  // either way — but the real fields live one level down, leaving
  // asset/quantity/floorTotalUsd/horizonDays undefined at the top. That used
  // to surface as a misleading "Unsupported asset: undefined", which looks
  // like an asset validation failure rather than a shape problem. It must
  // now be reported as a clear, correctly-attributed shape error instead.
  it('rejects a nested answer object with a shape error, not a misleading asset error', async () => {
    const promise = parseIntent(
      'x',
      llmReturning('{"result":{"asset":"ETH","quantity":1,"floorTotalUsd":2300,"horizonDays":14}}'),
    );
    await expect(promise).rejects.toThrow(/shape/i);
    await expect(promise).rejects.not.toThrow(/Unsupported asset/);
  });

  // Regression: if the model echoes a format example before its real answer,
  // the old greedy regex spanned BOTH `{...}` objects plus the prose between
  // them, so `JSON.parse` threw and the user saw "invalid JSON" for what was
  // actually a usable answer sitting later in the string. The balanced-brace
  // scanner instead grabs the first complete object it finds (here, the
  // format example) — which is itself an inherent ambiguity in extracting
  // from unstructured prose, not something a smarter scanner fully resolves.
  // What matters is that the outcome fails closed with a clear, attributable
  // error (not a crash, and not the old "invalid JSON" message) rather than
  // silently fabricating or misreporting a number.
  it('fails closed (not a JSON-parse crash) when a format example precedes the real answer', async () => {
    const promise = parseIntent(
      'x',
      llmReturning('Format: {"asset":"ETH"} Answer: {"asset":"BTC","quantity":1,"floorTotalUsd":60000,"horizonDays":30}'),
    );
    await expect(promise).rejects.toThrow(/quantity/i);
    await expect(promise).rejects.not.toThrow(/invalid JSON/);
  });
});

describe('validateSpec', () => {
  it('round-trips a valid spec object', () => {
    expect(validateSpec({ asset: 'ETH', quantity: 1, floorTotalUsd: 2300, horizonDays: 14 })).toEqual({
      asset: 'ETH', quantity: 1, floorTotalUsd: 2300, horizonDays: 14,
    });
  });

  it('accepts a fractional quantity with a sane implied strike (the $798-for-0.32-ETH case, corrected)', () => {
    const spec = validateSpec({ asset: 'ETH', quantity: 0.32, floorTotalUsd: 798, horizonDays: 14 });
    expect(spec.quantity).toBe(0.32);
    expect(spec.floorTotalUsd).toBe(798);
  });
});
```

Note: the "format example precedes the real answer" test changes its expected rejection message from `/floor/i` to `/quantity/i` — the format example `{"asset":"ETH"}` is missing `quantity` now (it was previously missing `floorUsd`, which used to fail on the floor-range check first; with the new required-field order, the missing-quantity check fires first). Confirm this against the actual `validateSpec` field-check order you write in Step 3 below, and adjust the regex if the order differs — the test must match the real first failure, not an assumed one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/intent.test.ts`
Expected: FAIL — `validateSpec` still expects/returns `floorUsd`, has no `quantity` handling, and the SYSTEM prompt hasn't changed (prompt content isn't asserted directly, but the shape of `parseIntent`'s output is).

- [ ] **Step 3: Update the SYSTEM prompt and `validateSpec`**

In `src/intent.ts`, replace lines 37-41:

```ts
const SYSTEM = `You translate a user's crypto-protection request into JSON. Output ONLY a JSON object, nothing else.
Fields: "asset" ("ETH" or "BTC" — the asset they hold), "floorUsd" (number — the minimum USD value they need), "horizonDays" (number — how many days until their deadline).
"two weeks" means 14. "a month" means 30. "end of next week" means about 10.
If the text is NOT a request to protect a crypto holding's value, output {"error":"<one short sentence why>"}.
Never invent a floor or horizon that is not stated or clearly implied by the text.`;
```

with:

```ts
const SYSTEM = `You translate a user's crypto-protection request into JSON. Output ONLY a JSON object, nothing else.
Fields:
- "asset" ("ETH" or "BTC" — the asset they hold)
- "quantity" (number — how much of the asset they hold)
- "floorTotalUsd" (number — the total USD value they need their WHOLE holding to be worth)
- "horizonDays" (number — how many days until their deadline)
"two weeks" means 14. "a month" means 30. "end of next week" means about 10.
Do NOT divide, multiply, or otherwise compute a per-unit price. Report only the numbers as stated or clearly implied — quantity and floorTotalUsd are separate, literal transcriptions, never derived from each other.
If the text is NOT a request to protect a crypto holding's value, output {"error":"<one short sentence why>"}.
Never invent a quantity, floor, or horizon that is not stated or clearly implied by the text.`;
```

Replace `validateSpec` (lines 94-115):

```ts
/** Strict validation — the only gate between LLM output and the product. Pure; reused by the server. */
export function validateSpec(obj: any): ProtectionSpec {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`Malformed response shape: expected a JSON object with "asset"/"floorUsd"/"horizonDays" fields, got: ${JSON.stringify(obj)}`);
  }
  if (!('asset' in obj) && !('floorUsd' in obj) && !('horizonDays' in obj)) {
    const keys = Object.keys(obj).join(', ') || 'none';
    throw new Error(`Malformed response shape: expected top-level "asset"/"floorUsd"/"horizonDays" fields but found none (got keys: ${keys}) — the model may have nested its answer under another key.`);
  }
  const asset = obj.asset;
  const floorUsd = Number(obj.floorUsd);
  const horizonDays = Number(obj.horizonDays);
  if (asset !== 'ETH' && asset !== 'BTC') {
    throw new Error(`Unsupported asset: ${JSON.stringify(obj.asset)} — Payung protects ETH or BTC.`);
  }
  if (!Number.isFinite(floorUsd) || floorUsd < 1 || floorUsd > 10_000_000) {
    throw new Error(`Implausible floor price: ${JSON.stringify(obj.floorUsd)}`);
  }
  if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 90) {
    throw new Error(`Horizon must be 1-90 days, got: ${JSON.stringify(obj.horizonDays)}`);
  }
  return { asset, floorUsd, horizonDays };
}
```

with:

```ts
/** Strict validation — the only gate between LLM output and the product. Pure; reused by the server. */
export function validateSpec(obj: any): ProtectionSpec {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`Malformed response shape: expected a JSON object with "asset"/"quantity"/"floorTotalUsd"/"horizonDays" fields, got: ${JSON.stringify(obj)}`);
  }
  if (!('asset' in obj) && !('quantity' in obj) && !('floorTotalUsd' in obj) && !('horizonDays' in obj)) {
    const keys = Object.keys(obj).join(', ') || 'none';
    throw new Error(`Malformed response shape: expected top-level "asset"/"quantity"/"floorTotalUsd"/"horizonDays" fields but found none (got keys: ${keys}) — the model may have nested its answer under another key.`);
  }
  const asset = obj.asset;
  const quantity = Number(obj.quantity);
  const floorTotalUsd = Number(obj.floorTotalUsd);
  const horizonDays = Number(obj.horizonDays);
  if (asset !== 'ETH' && asset !== 'BTC') {
    throw new Error(`Unsupported asset: ${JSON.stringify(obj.asset)} — Payung protects ETH or BTC.`);
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`I need to know how much ${asset} you hold — missing or invalid quantity: ${JSON.stringify(obj.quantity)}`);
  }
  if (!Number.isFinite(floorTotalUsd) || floorTotalUsd < 1 || floorTotalUsd > 10_000_000_000) {
    throw new Error(`Implausible total floor value: ${JSON.stringify(obj.floorTotalUsd)}`);
  }
  if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 90) {
    throw new Error(`Horizon must be 1-90 days, got: ${JSON.stringify(obj.horizonDays)}`);
  }
  const spec: ProtectionSpec = { asset, quantity, floorTotalUsd, horizonDays };
  const strike = impliedStrike(spec);
  if (!Number.isFinite(strike) || strike < 1 || strike > 10_000_000) {
    throw new Error(
      `Implied per-unit strike ($${floorTotalUsd} / ${quantity} ${asset} = $${Number.isFinite(strike) ? strike.toFixed(2) : strike}) is implausible — check your quantity and total value.`
    );
  }
  return spec;
}
```

And repoint the import at the top of `src/intent.ts` — replace line 8:

```ts
import type { ProtectionSpec } from './core.js';
```

with:

```ts
// From './spec.js', NOT './core.js' — impliedStrike is used at runtime here,
// and a value import of core.ts would pull dotenv + the Thetanuts SDK into
// this module and into the zero-network intent tests (HANDOFF.md rule 1).
import { impliedStrike, type ProtectionSpec } from './spec.js';
```

Verify this held: `npx vitest run tests/intent.test.ts` should still run without a `.env` present and without any network access.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/intent.test.ts`
Expected: PASS (all tests). If the "format example" test's expected regex doesn't match the real first-thrown error, fix the test's regex to match reality (per the note in Step 1) — do not change `validateSpec`'s check order just to satisfy a guessed regex.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: `tests/implied-strike.test.ts`, `tests/filter.test.ts`, `tests/intent.test.ts` all pass. Other files depending on the old `ProtectionSpec`/`floorUsd` shape (`tests/wire.test.ts`, `tests/coverage.test.ts`, `src/server.ts`, `src/cli.ts`) are fixed in Tasks 4–5 — confirm remaining failures are limited to those.

- [ ] **Step 6: Commit**

```bash
git add src/intent.ts tests/intent.test.ts
git commit -m "feat: intent.ts transcribes quantity + total floor instead of guessing a basis"
```

---

## Task 4: `server.ts` — wire format and routes move to the new spec shape, `toWire` carries `impliedStrike` and distance-from-spot

**Files:**
- Modify: `src/server.ts:41-56` (`toWire`), `src/server.ts:160-191` (`/api/candidates`, `/api/quote`)
- Modify: `tests/wire.test.ts`

**Interfaces:**
- Consumes: `impliedStrike` from `src/core.ts` (re-exported from `src/spec.ts`, Task 1)
- Produces: `toWire(c, spec)` response now includes `impliedStrike: number`, `pctVsImpliedStrike: number` (**signed** — positive means the candidate's strike sits *below* the user's implied strike, i.e. a weaker floor; negative means above, i.e. a stronger but pricier one), and `pctFromImpliedStrike: number` (the **absolute** distance). Task 10 gates the "closest match" badge on the absolute figure and labels with the signed one.

**Why two numbers and not one clamped one:** an earlier draft used `Math.max(0, ((implied - c.strike) / implied) * 100)`, which scores *every* candidate at or above the implied strike as `0` — i.e. "perfect match". But `filterCandidates` ranks by **absolute** distance, so when the live book's nearest strikes all sit above the user's floor, `list[0]` can be far above it and would still earn a green "closest match" badge while the far-miss warning never fires. A strike 30% above the requested floor is a genuine mismatch (it costs far more than asked for), not a perfect one.

- [ ] **Step 1: Update the failing test first**

In `tests/wire.test.ts`, replace line 5:

```ts
const spec = { asset: 'ETH' as const, floorUsd: 2300, horizonDays: 14 };
```

with:

```ts
const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };
```

Append a new test inside `describe('wire format', ...)`:

```ts
  it('toWire carries the implied strike derived from quantity + total floor', () => {
    const twoEthSpec = { asset: 'ETH' as const, quantity: 2, floorTotalUsd: 4600, horizonDays: 14 };
    const w = toWire(makeCandidate({ strike: 2200 }), twoEthSpec);
    expect(w.impliedStrike).toBe(2300); // 4600 / 2
    expect(w.pctVsImpliedStrike).toBeCloseTo(((2300 - 2200) / 2300) * 100, 5);
    expect(w.pctFromImpliedStrike).toBeCloseTo(((2300 - 2200) / 2300) * 100, 5);
  });

  it('reports a strike ABOVE the implied one as a real distance, not a perfect match', () => {
    const spec1 = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };
    const w = toWire(makeCandidate({ strike: 2990 }), spec1); // 30% above the floor
    expect(w.pctVsImpliedStrike).toBeCloseTo(-30, 5); // negative = above
    expect(w.pctFromImpliedStrike).toBeCloseTo(30, 5); // absolute distance gates the badge
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/wire.test.ts`
Expected: FAIL — `toWire`'s return type has no `impliedStrike`/`pctVsImpliedStrike`/`pctFromImpliedStrike` fields, and the file won't typecheck against the new `ProtectionSpec` shape.

- [ ] **Step 3: Update `toWire`**

In `src/server.ts`, replace lines 45-56:

```ts
export function toWire(c: Candidate, spec: ProtectionSpec) {
  return {
    id: candidateId(c),
    strike: c.strike,
    expiryIso: c.expiry.toISOString(),
    daysToExpiry: c.daysToExpiry,
    pricePerContract: c.pricePerContract,
    iv: c.greeks.iv ?? null,
    coverageGapDays: coverageGapDays(c, spec),
    makerBudget: c.makerBudget,
  };
}
```

with:

```ts
export function toWire(c: Candidate, spec: ProtectionSpec) {
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
  };
}
```

Naming note: the local is `target`, not `strike` — `strike:` in the returned object is the *candidate's* strike, and shadowing that name with the user's implied strike is exactly the per-unit-vs-total confusion this whole plan exists to remove.

Add `impliedStrike` to the import from `./core.js` at the top of `src/server.ts` (currently line 14-18) — add it to the existing named-import list alongside `findCandidates, quote, simulate, ...`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/wire.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm `/api/candidates` and `/api/quote` need no further change**

Read `src/server.ts:160-191` again after the Step 3 edit: `/api/candidates` calls `validateSpec(body.spec)` (already fixed in Task 3) and `findCandidates(spec)` (already spec-shape-agnostic — it only reads `spec.asset` and passes `spec` through to `filterCandidates`, fixed in Task 2), then maps through the updated `toWire`. `/api/quote` never references `floorUsd`/`floorTotalUsd` directly. No code change needed here — this step is a read-through confirmation, not a code step.

- [ ] **Step 6: Update `tests/coverage.test.ts`'s spec fixture to the new shape**

`tests/coverage.test.ts` independently constructs a `ProtectionSpec` literal that still uses the old shape. Replace line 5:

```ts
const spec = { asset: 'ETH' as const, floorUsd: 2300, horizonDays: 14 };
```

with:

```ts
const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };
```

`coverageGapDays(candidate, spec)` only ever reads `spec.horizonDays`, so no other change is needed in that file.

- [ ] **Step 7: Full suite + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: All test files pass — `tests/coverage.test.ts`, `tests/wire.test.ts`, `tests/filter.test.ts`, `tests/implied-strike.test.ts`, `tests/intent.test.ts`. `src/cli.ts` still won't typecheck (fixed in Task 5) — confirm that is the only remaining error besides the one pre-existing `chainConfig.contracts.optionBook` error noted in Global Constraints.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts tests/wire.test.ts tests/coverage.test.ts
git commit -m "feat: server wire format carries impliedStrike and distance-from-implied-strike"
```

---

## Task 5: `cli.ts` breaking arg-shape change, plus doc updates for the new CLI usage

**Files:**
- Modify: `src/cli.ts:94-217` (`quote`/`simulate`/`execute`, `preflight`, `ask`, the usage banner, and the top-of-file comment)
- Modify: `README.md` (the `npm run ask --` example line)
- Modify: `docs/demo-runbook.md` (the `preflight`/`execute` example invocations)

**Interfaces:**
- Consumes: `ProtectionSpec` shape from Task 1, `impliedStrike` from `src/core.ts`

- [ ] **Step 1: Update the top-of-file usage comment**

In `src/cli.ts`, replace lines 1-14:

```ts
/**
 * Day 1 CLI. Get a real transaction hash before you write a single line of UI.
 *
 *   npm run book                        # what's live right now
 *   npm run quote -- 2300 10 14         # price a $2300 floor with 10 USDC, 14d horizon (default 14)
 *   npm run whoami                      # check your burner wallet balances
 *   npm run deposit -- 12               # top up aBasUSDC via Aave if short
 *   npm run simulate -- 2300 10 14      # FREE dry run of the real transaction
 *   npm run execute -- 2300 10 14       # spends real USDC on Base mainnet
 *
 * floorUsd defaults to 2300 and horizonDays to 14 on quote/simulate/execute —
 * the same defaults `preflight` uses, so a candidate vetted with `preflight`
 * is the same candidate `execute` will pick when run with no arguments.
 */
```

with:

```ts
/**
 * Day 1 CLI. Get a real transaction hash before you write a single line of UI.
 *
 *   npm run book                              # what's live right now
 *   npm run quote -- 1 2300 10 14             # price "1 ETH, $2300 total floor" with 10 USDC, 14d horizon (default 14)
 *   npm run whoami                             # check your burner wallet balances
 *   npm run deposit -- 12                      # top up aBasUSDC via Aave if short
 *   npm run simulate -- 1 2300 10 14           # FREE dry run of the real transaction
 *   npm run execute -- 1 2300 10 14            # spends real USDC on Base mainnet
 *
 * quantity defaults to 1, floorTotal to 2300, and horizonDays to 14 on
 * quote/simulate/execute — the same defaults `preflight` uses, so a
 * candidate vetted with `preflight` is the same candidate `execute` will
 * pick when run with no arguments. The strike matched against is DERIVED
 * (floorTotal / quantity) — see impliedStrike() in core.ts; there is no
 * separate per-unit-price argument.
 */
```

- [ ] **Step 2: Update the `quote`/`simulate`/`execute` case**

In `src/cli.ts`, replace lines 94-166 (the `case 'quote': case 'simulate': case 'execute':` block) — specifically the arg parsing and spec construction and display lines. Replace:

```ts
    case 'quote':
    case 'simulate':
    case 'execute': {
      const floorUsd = Number(args[0] ?? 2300);
      const collateral = Number(args[1] ?? 10);
      const horizonDays = Number(args[2] ?? 14);

      const spec = { asset: 'ETH' as const, floorUsd, horizonDays };
      const candidates = await findCandidates(spec, readClient());
      if (!candidates.length) {
        console.log('No fillable structure matches that constraint right now.');
        console.log('(This is the correct answer. Do not let the agent improvise one.)');
        return;
      }

      console.log(`\nCandidates for a ${usd(floorUsd)} floor on ETH:\n`);
      candidates.forEach(show);
```

with:

```ts
    case 'quote':
    case 'simulate':
    case 'execute': {
      const quantity = Number(args[0] ?? 1);
      const floorTotalUsd = Number(args[1] ?? 2300);
      const collateral = Number(args[2] ?? 10);
      const horizonDays = Number(args[3] ?? 14);

      const spec = { asset: 'ETH' as const, quantity, floorTotalUsd, horizonDays };
      const strike = impliedStrike(spec);
      const candidates = await findCandidates(spec, readClient());
      if (!candidates.length) {
        console.log('No fillable structure matches that constraint right now.');
        console.log('(This is the correct answer. Do not let the agent improvise one.)');
        return;
      }

      console.log(`\nCandidates for ${quantity} ETH needing ${usd(floorTotalUsd)} total (implied strike ${usd(strike)}):\n`);
      candidates.forEach(show);
```

The rest of the block (from `const pick = candidates[0];` through the end of the `case`) references `pick`, `q`, `curve`, `j` — none of which reference `floorUsd` — so it is unchanged.

- [ ] **Step 3: Update the `preflight` case**

Replace lines 169-175:

```ts
    case 'preflight': {
      // Run minutes before the demo: is the pipeline alive, and which candidates are actually fillable RIGHT NOW?
      const spec = {
        asset: 'ETH' as const,
        floorUsd: Number(args[0] ?? 2300),
        horizonDays: Number(args[1] ?? 14),
      };
```

with:

```ts
    case 'preflight': {
      // Run minutes before the demo: is the pipeline alive, and which candidates are actually fillable RIGHT NOW?
      const spec = {
        asset: 'ETH' as const,
        quantity: Number(args[0] ?? 1),
        floorTotalUsd: Number(args[1] ?? 2300),
        horizonDays: Number(args[2] ?? 14),
      };
```

And update the log line just below (currently `console.log(\`\nbook+filter latency ${Date.now() - t0}ms · ${candidates.length} candidates for $${spec.floorUsd}/${spec.horizonDays}d\`);`) to:

```ts
      console.log(`\nbook+filter latency ${Date.now() - t0}ms · ${candidates.length} candidates for $${spec.floorTotalUsd} total on ${spec.quantity} ETH / ${spec.horizonDays}d`);
```

- [ ] **Step 4: Update the `ask` case's log line**

Replace the line inside `case 'ask':` that reads:

```ts
      console.log(`\nParsed: protect ${spec.asset} at a $${spec.floorUsd} floor for ${spec.horizonDays} days\n`);
```

with:

```ts
      console.log(`\nParsed: protect ${spec.quantity} ${spec.asset} at a $${spec.floorTotalUsd} total floor for ${spec.horizonDays} days (implied strike $${impliedStrike(spec).toFixed(2)})\n`);
```

- [ ] **Step 5: Update the `default` usage banner**

Replace lines 209-217:

```ts
    default:
      console.log('commands: book | whoami | deposit | quote | simulate | execute | preflight | ask');
      console.log('  npm run book');
      console.log('  npm run quote -- 2400 10 14');
      console.log('  npm run simulate -- 2400 10 14');
      console.log('  npm run execute -- 2400 10 14');
      console.log('  npm run deposit -- 12');
      console.log('  npm run preflight -- 2300 14');
      console.log('  npm run ask -- "I have 1 ETH and need it worth at least $2,300 in two weeks"');
```

with:

```ts
    default:
      console.log('commands: book | whoami | deposit | quote | simulate | execute | preflight | ask');
      console.log('  npm run book');
      console.log('  npm run quote -- 1 2400 10 14        # <quantity> <floorTotalUsd> <collateralUsdc> [horizonDays]');
      console.log('  npm run simulate -- 1 2400 10 14');
      console.log('  npm run execute -- 1 2400 10 14');
      console.log('  npm run deposit -- 12');
      console.log('  npm run preflight -- 1 2300 14        # <quantity> <floorTotalUsd> [horizonDays]');
      console.log('  npm run ask -- "I have 1 ETH and need it worth at least $2,300 in two weeks"');
```

- [ ] **Step 6: Add the `impliedStrike` import**

In `src/cli.ts`, the existing import from `./core.js` (lines 18-22) already lists several names — add `impliedStrike` to that list.

- [ ] **Step 7: Typecheck and manually verify against the live book**

Run: `npx tsc --noEmit`
Expected: `src/cli.ts` now typechecks against the new `ProtectionSpec` shape. (This is CLI/network code — no vitest coverage per repo convention; verify manually.)

Run: `npm run quote -- 1 2300 10 14`
Expected: prints "Candidates for 1 ETH needing $2300.00 total (implied strike $2300.00):" followed by the live book's matching candidates, same as before this change for a quantity of 1.

Run: `npm run quote -- 0.32 798 5 14`
Expected: prints "Candidates for 0.32 ETH needing $798.00 total (implied strike $2493.75):" — confirming the original bug (matching against a raw $798 strike) is fixed at the CLI layer.

- [ ] **Step 8: Update README.md and docs/demo-runbook.md example invocations**

In `README.md`, the `npm run ask --` example at line 45 needs no change (it's natural language, unaffected). But **`README.md:33` does document the old spec shape** and must be updated — it is the README's single load-bearing sentence about the AI's contract. Replace:

```
The LLM (Gonka Router — a MUBA sponsor) does exactly one job: parse a sentence into
`{asset, floorUsd, horizonDays}`, strictly validated. It never generates a price, a
prediction, or any number the user sees.
```

with:

```
The LLM (Gonka Router — a MUBA sponsor) does exactly one job: transcribe a sentence into
`{asset, quantity, floorTotalUsd, horizonDays}`, strictly validated. It is explicitly
forbidden from dividing or multiplying — the per-unit strike a match is ranked against is
derived in tested code (`impliedStrike`), never by the model. It never generates a price, a
prediction, or any number the user sees.
```

Also update the stale schema comment at `src/server.ts:154`, which still reads `{asset, floorUsd, horizonDays}`, to the four-field shape. (Comment only — no behavior change — but leaving it contradicts the code directly above it.)

Then re-run `grep -rn "floorUsd" src/ tests/ web/ README.md docs/` and confirm **zero** hits remain. At the time this plan was written the full set was: `src/core.ts` (Task 1–2), `src/intent.ts` + `tests/intent.test.ts` (Task 3), `tests/filter.test.ts` (Task 2), `tests/wire.test.ts` + `tests/coverage.test.ts` (Task 4), `src/cli.ts` (Task 5), `web/index.html` (Task 6), and `README.md:33` + `src/server.ts:154` (this step). `tests/fixtures.ts` contains no spec literal and needs no change, despite the design doc's §3.4 listing it.

In `docs/demo-runbook.md`, replace line 11-12:

```
- [ ] **Execute the banked trade:** `npm run preflight -- 2300 14`, pick the top ✓ candidate,
      then run the full flow in the web app (or `npm run execute -- 2300 10`) and SAVE:
```

with:

```
- [ ] **Execute the banked trade:** `npm run preflight -- 1 2300 14`, pick the top ✓ candidate,
      then run the full flow in the web app (or `npm run execute -- 1 2300 10`) and SAVE:
```

And replace line 39:

```
- [ ] `npm run preflight -- <floor> <days>` — confirms RPC latency and 3 fillable fallbacks.
```

with:

```
- [ ] `npm run preflight -- <quantity> <floorTotal> <days>` — confirms RPC latency and 3 fillable fallbacks.
```

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts src/server.ts README.md docs/demo-runbook.md
git commit -m "feat!: CLI quote/simulate/execute/preflight take quantity + total floor

BREAKING CHANGE: quote/simulate/execute args are now
<quantity> <floorTotalUsd> <collateralUsdc> [horizonDays]
instead of <floorUsd> <collateralUsdc> [horizonDays]. preflight is now
<quantity> <floorTotalUsd> [horizonDays]. The strike matched against is
derived (floorTotalUsd / quantity), never a separate argument."
```

---

## Task 6: Web form wiring — quantity reaches the server, restated sentence shows the derived strike, NL parse fills the amount field

**Files:**
- Modify: `web/index.html` (`currentSpec()`, `restateSentence()`, `parseNL()`)

**Interfaces:**
- Consumes: `POST /api/parse` now returns `{spec: {asset, quantity, floorTotalUsd, horizonDays}}` (Task 3's server-side change flows through automatically — no server code changes needed here beyond what Tasks 3–4 already did)
- Produces: `currentSpec()` returns `{asset, quantity, floorTotalUsd, horizonDays}`

- [ ] **Step 1: Update `restateSentence()` to show the derived per-unit strike**

**Stated exception to Global Constraint "presentation layers never compute a number":** this step knowingly duplicates the `impliedStrike` division in client JS. It is allowed here and *only* here, because `restateSentence()` runs on every keystroke before any server round-trip exists to ask, and its output is read-only prose. Two hard limits: (a) the duplicated value must never be fed back into a request, a filter, or a decision — the number that gates matching always comes from the server; and (b) once `toWire`'s `impliedStrike` is available (after "Find real offers"), any per-unit figure shown alongside candidates or the quote must come from the wire, not from this function. Recording it here rather than only in a code comment because a silent divergence between these two readings of the floor is the exact bug class this plan exists to eliminate.

Replace (around line 644-651):

```js
function restateSentence() {
  const asset = document.getElementById('asset').value;
  const amount = document.getElementById('amount').value || '1';
  const floor = Number(document.getElementById('floor').value || 0).toLocaleString();
  const days = document.getElementById('days').value || '14';
  document.getElementById('restated').innerHTML =
    `"I have <b>${amount} ${asset}</b>. I need it to be worth at least <b class="accent">$${floor}</b> in <b>${days} days</b>."`;
}
```

with:

```js
function restateSentence() {
  const asset = document.getElementById('asset').value;
  const amount = Number(document.getElementById('amount').value) || 1;
  const floorTotal = Number(document.getElementById('floor').value) || 0;
  const days = document.getElementById('days').value || '14';
  // Same formula as core.ts's impliedStrike(), duplicated deliberately: this
  // is live-as-you-type feedback before any server round trip exists to ask.
  // The number that actually GATES a match (filterCandidates' ranking,
  // validateSpec's plausibility check) always comes from the server's
  // impliedStrike() — this is display-only, never fed back into a decision.
  const perUnit = amount > 0 ? floorTotal / amount : 0;
  document.getElementById('restated').innerHTML =
    `"I have <b>${amount} ${asset}</b>. I need it to be worth at least <b class="accent">$${floorTotal.toLocaleString()}</b> total in <b>${days} days</b>" ` +
    `— that's a floor of <b class="accent">$${perUnit.toLocaleString(undefined, {maximumFractionDigits: 2})} per ${asset}</b>.`;
}
```

- [ ] **Step 2: Update `currentSpec()` to send `quantity`/`floorTotalUsd`**

Replace (around line 693-699):

```js
function currentSpec() {
  return {
    asset: document.getElementById('asset').value,
    floorUsd: Number(document.getElementById('floor').value),
    horizonDays: Number(document.getElementById('days').value),
  };
}
```

with:

```js
function currentSpec() {
  return {
    asset: document.getElementById('asset').value,
    quantity: Number(document.getElementById('amount').value),
    floorTotalUsd: Number(document.getElementById('floor').value),
    horizonDays: Number(document.getElementById('days').value),
  };
}
```

- [ ] **Step 3: Update `parseNL()` to fill the amount field**

Replace (around line 664-682):

```js
async function parseNL() {
  const text = document.getElementById('nl').value.trim();
  const err = document.getElementById('nlError');
  const btn = document.getElementById('nlBtn');
  err.textContent = '';
  if (!text) return;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const { spec } = await api('/api/parse', { text });
    document.getElementById('asset').value = spec.asset;
    document.getElementById('floor').value = spec.floorUsd;
    document.getElementById('days').value = spec.horizonDays;
    restateSentence();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Parse';
  }
}
```

with:

```js
async function parseNL() {
  const text = document.getElementById('nl').value.trim();
  const err = document.getElementById('nlError');
  const btn = document.getElementById('nlBtn');
  err.textContent = '';
  if (!text) return;
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const { spec } = await api('/api/parse', { text });
    document.getElementById('asset').value = spec.asset;
    document.getElementById('amount').value = spec.quantity;
    document.getElementById('floor').value = spec.floorTotalUsd;
    document.getElementById('days').value = spec.horizonDays;
    restateSentence();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Parse';
  }
}
```

- [ ] **Step 4: Update the default placeholder sentence in the HTML (not just the JS-generated one)**

Replace line 398-400:

```html
    <p class="sentence" id="restated">
      "I have <b>1 ETH</b>. I need it to be worth at least <b class="accent">$2,300</b> in <b>14 days</b>."
    </p>
```

with:

```html
    <p class="sentence" id="restated">
      "I have <b>1 ETH</b>. I need it to be worth at least <b class="accent">$2,300</b> total in <b>14 days</b>" — that's a floor of <b class="accent">$2,300 per ETH</b>.
    </p>
```

- [ ] **Step 5: Manual verification (no build step — this is static HTML/JS)**

Run: `npm run web`, open `http://localhost:8787` in a browser.
Expected: typing "I have 0.32 ETH and need it worth at least $798 in two weeks" into the NL box and clicking Parse fills Amount=0.32, Floor=798, Days=14, and the restated sentence reads "...that's a floor of $2,493.75 per ETH." Manually editing Amount or Floor updates the per-ETH clause live.

- [ ] **Step 6: Commit**

```bash
git add web/index.html
git commit -m "feat: web UI sends quantity to the server and shows the derived per-unit strike"
```

---

## Task 7: `src/spot.ts` — pure candle normalization (`toCandles`)

**Files:**
- Create: `src/spot.ts`
- Test: `tests/spot.test.ts` (new)

**Interfaces:**
- Produces: `type Candle = { t: number; o: number; h: number; l: number; c: number }`
- Produces: `toCandles(rawRows: number[][]): Candle[]` — pure, normalizes Coinbase Exchange's raw candle row shape

Coinbase Exchange's public candles endpoint (`GET /products/{id}/candles`) returns each row as `[time, low, high, open, close, volume]` (numbers, low/high before open/close — this exact ordering is Coinbase's documented format and is NOT `[t,o,h,l,c]`; `toCandles` exists specifically to fix this into a sane shape once, in one tested place, rather than have every caller remember the raw ordering).

- [ ] **Step 1: Write the failing test**

Create `tests/spot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toCandles } from '../src/spot.js';

describe('toCandles', () => {
  it('normalizes Coinbase [time, low, high, open, close, volume] rows into {t,o,h,l,c}', () => {
    const raw = [
      [1700000000, 2400, 2450, 2420, 2440, 1234.5],
      [1700000060, 2440, 2460, 2440, 2455, 987.6],
    ];
    expect(toCandles(raw)).toEqual([
      { t: 1700000000, o: 2420, h: 2450, l: 2400, c: 2440 },
      { t: 1700000060, o: 2440, h: 2460, l: 2440, c: 2455 },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(toCandles([])).toEqual([]);
  });

  it('drops malformed rows (wrong length) instead of throwing', () => {
    const raw = [
      [1700000000, 2400, 2450, 2420, 2440, 1234.5],
      [1700000060, 2440], // malformed
    ];
    expect(toCandles(raw)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/spot.test.ts`
Expected: FAIL — `src/spot.ts` doesn't exist yet.

- [ ] **Step 3: Create `src/spot.ts` with `toCandles`**

```ts
/**
 * Price history + spot for the UI's chart. Deliberately separate from
 * core.ts — a price oracle is not a Thetanuts concern (design rule: core.ts
 * is the only module that touches the Thetanuts SDK; this module must never
 * import it, not even as a type).
 *
 * Consequence for the API below: fetchSpot() takes a feed address and an
 * ethers.Provider as plain arguments rather than a ThetanutsClient. The
 * caller (server.ts) already holds a client and reads client.provider and
 * client.chainConfig.priceFeeds[asset] off it — both are public, typed
 * fields. Keeping those two values as parameters is what lets this module
 * stay SDK-free and independently testable.
 */

export type Candle = { t: number; o: number; h: number; l: number; c: number };

/**
 * Normalize Coinbase Exchange's raw candle rows.
 *
 * GOTCHA: Coinbase's documented row order is
 * [time, low, high, open, close, volume] — NOT [t, o, h, l, c]. Getting this
 * wrong silently swaps open/close and high/low on every candle. This
 * function is the one place that ordering is handled, tested in isolation,
 * so no caller has to remember it.
 */
export function toCandles(rawRows: number[][]): Candle[] {
  const out: Candle[] = [];
  for (const row of rawRows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, low, high, open, close] = row;
    out.push({ t, o: open, h: high, l: low, c: close });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/spot.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/spot.ts tests/spot.test.ts
git commit -m "feat: pure Coinbase candle normalization (src/spot.ts)"
```

---

## Task 8: `src/spot.ts` async fetchers (`fetchHistory`, `fetchSpot`) + `GET /api/history` route

**Files:**
- Modify: `src/spot.ts` (add `fetchHistory`, `fetchSpot`)
- Modify: `src/server.ts` (new `/api/history` route + in-memory cache)

**Interfaces:**
- Consumes: `toCandles` from Task 7. The caller reads `client.provider` and `client.chainConfig.priceFeeds[asset]` (both public, typed fields on `ThetanutsClient`) and passes them in — this module never imports the SDK.
- Produces: `fetchHistory(asset: 'ETH' | 'BTC', days: number): Promise<Candle[]>`
- Produces: `fetchSpot(feed: string, provider: ethers.Provider): Promise<{price: number; updatedAt: string; feed: string}>`
- Produces: `granularityFor(days: number): number` — exported for unit testing (see Step 1b)
- Produces: `GET /api/history?asset=ETH&days=N` → `{candles: Candle[], spot: {price, updatedAt, feed, source: 'chainlink'} | null, historySource: 'coinbase-exchange' | null}`

**Verified against the live chain before this plan was finalized** (so don't re-litigate it, but do re-check if the SDK version changes): `chainConfig.priceFeeds.ETH` = `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` and `.BTC` = `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F`. Both answer `latestRoundData()` and `decimals()` (8), and ETH's `description()` returns `"ETH / USD"`. They are genuine Chainlink AggregatorV3 proxies, so the "the spot marker is the settlement price" claim is real, not assumed. Note `priceFeeds` also contains SOL/DOGE/XRP/BNB/PAXG/AVAX entries — irrelevant here, since `validateSpec` only admits ETH and BTC.

- [ ] **Step 1: Add `fetchHistory` and `fetchSpot` to `src/spot.ts`**

Add the `ethers` import **at the top of the file**, above the `Candle` type — not appended after `toCandles`. (ESM hoists imports so either position runs, but imports buried mid-file are a readability trap.) There is deliberately **no** `@thetanuts-finance/thetanuts-client` import, not even `import type`:

```ts
import { ethers } from 'ethers';
```

Then append the rest after `toCandles`:

```ts
const COINBASE_PRODUCT: Record<'ETH' | 'BTC', string> = { ETH: 'ETH-USD', BTC: 'BTC-USD' };

/** Granularities Coinbase Exchange accepts, in seconds. Anything else is a 400. */
const COINBASE_GRANULARITIES = [60, 300, 900, 3600, 21600, 86400];

/** Coinbase caps ONE request at 300 candles, regardless of granularity. */
const COINBASE_MAX_CANDLES = 300;

/**
 * Smallest accepted granularity that keeps `days` of history under Coinbase's
 * 300-candle-per-request cap.
 *
 * GOTCHA (confirmed against the live API, not inferred): exceeding the cap is
 * a hard `400 {"message":"granularity too small for the requested time range.
 * Count of aggregations requested exceeds 300"}`, not a truncated response. A
 * fixed if/else ladder gets this wrong at both ends of the 1-90 day range the
 * horizon field allows — 2 days at 5m granularity is 576 candles (400), and
 * 90 days at 6h is 360 candles (400). Deriving the granularity from the cap
 * is the only version that holds across the whole range.
 */
export function granularityFor(days: number): number {
  const minSecondsPerCandle = (days * 86400) / COINBASE_MAX_CANDLES;
  return COINBASE_GRANULARITIES.find((g) => g >= minSecondsPerCandle) ?? 86400;
}

/**
 * Real OHLC history from Coinbase Exchange's public candles endpoint. No API
 * key required. Returns [] on any fetch/parse failure — this is a chart
 * enhancement, never a gate on the trading flow (see server.ts's /api/history
 * route, which degrades to spot-only rather than failing the request).
 */
export async function fetchHistory(asset: 'ETH' | 'BTC', days: number): Promise<Candle[]> {
  const product = COINBASE_PRODUCT[asset];
  const granularity = granularityFor(days);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400 * 1000);
  const url = `https://api.exchange.coinbase.com/products/${product}/candles` +
    `?start=${start.toISOString()}&end=${end.toISOString()}&granularity=${granularity}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'payung' } });
  if (!res.ok) throw new Error(`Coinbase candles ${res.status}: ${await res.text()}`);
  const rows: number[][] = await res.json();
  return toCandles(rows).sort((a, b) => a.t - b.t);
}

const AGGREGATOR_V3_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
];

/**
 * Live spot from the SAME Chainlink feed a candidate's option actually
 * settles against — the caller passes chainConfig.priceFeeds[asset], the
 * identical feed findCandidates() matches candidates on in core.ts. This is
 * deliberate: the spot marker on the chart must be the settlement price,
 * not a different exchange's idea of "current price".
 *
 * Takes (feed, provider) rather than a ThetanutsClient so this module stays
 * SDK-free (design rule 1) and testable against a stub provider.
 *
 * Retries once: the public Base RPC (mainnet.base.org) rate-limits under
 * light load and returns "missing revert data" for a call that succeeded
 * moments earlier — observed directly while verifying these feeds. A single
 * cheap retry turns the common transient into a non-event; a persistent
 * failure still surfaces to the caller, which degrades to spot-unavailable
 * rather than inventing a price.
 */
export async function fetchSpot(
  feed: string,
  provider: ethers.Provider
): Promise<{ price: number; updatedAt: string; feed: string }> {
  if (!feed) throw new Error('No price feed address supplied');
  const aggregator = new ethers.Contract(feed, AGGREGATOR_V3_ABI, provider);
  const read = async () => {
    const [decimals, round] = await Promise.all([
      aggregator.decimals(),
      aggregator.latestRoundData(),
    ]);
    const price = Number(round.answer) / 10 ** Number(decimals);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Feed ${feed} returned an unusable answer: ${round.answer}`);
    }
    return {
      price,
      updatedAt: new Date(Number(round.updatedAt) * 1000).toISOString(),
      feed: feed.toLowerCase(),
    };
  };
  try {
    return await read();
  } catch {
    return await read(); // one retry — see the rate-limiting note above
  }
}
```

- [ ] **Step 1b: Unit-test `granularityFor` (pure — add to `tests/spot.test.ts`)**

This is the function that was wrong; it must not regress silently. Append to the file created in Task 7:

```ts
import { granularityFor } from '../src/spot.js';

describe('granularityFor', () => {
  // The horizon field allows 1-90 days, and the /api/history route clamps to
  // that same range, so every value in it must stay under Coinbase's cap.
  it('keeps every day-count in the allowed 1-90 range under 300 candles', () => {
    for (let days = 1; days <= 90; days++) {
      const g = granularityFor(days);
      expect((days * 86400) / g).toBeLessThanOrEqual(300);
    }
  });

  it('only ever returns a granularity Coinbase accepts', () => {
    const allowed = [60, 300, 900, 3600, 21600, 86400];
    for (let days = 1; days <= 90; days++) {
      expect(allowed).toContain(granularityFor(days));
    }
  });

  // Regression guards for the two values a fixed if/else ladder got wrong.
  it('does not return 5m candles for a 2-day window (576 candles = HTTP 400)', () => {
    expect(granularityFor(2)).toBeGreaterThan(300);
  });

  it('does not return 6h candles for a 90-day window (360 candles = HTTP 400)', () => {
    expect(granularityFor(90)).toBeGreaterThan(21600);
  });
});
```

- [ ] **Step 2: Add the `/api/history` route to `src/server.ts`**

Add the import at the top of `src/server.ts`, alongside the existing `./core.js`/`./intent.js` imports:

```ts
import { fetchHistory, fetchSpot } from './spot.js';
```

Add a module-level cache near the existing `cache`/`CACHE_MAX_AGE_MS` declarations (around line 27-30):

```ts
/** Price history is expensive to refetch on every render tick — 60s is fresh enough for a chart. */
const historyCache = new Map<string, { body: any; fetchedAt: number }>();
const HISTORY_CACHE_MS = 60 * 1000;
```

Add the route inside `route(req, res)`, after the existing `GET`-adjacent routes and before the final `if (req.method === 'GET') return serveStatic(...)` fallback (i.e., insert just above line 305's `if (req.method === 'GET') return serveStatic(url, res);`):

```ts
  if (req.method === 'GET' && url === '/api/history') {
    const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const asset = params.get('asset');
    if (asset !== 'ETH' && asset !== 'BTC') {
      return send(res, 400, { error: 'asset must be ETH or BTC' });
    }
    const days = Math.min(90, Math.max(1, Number(params.get('days') ?? 14)));
    const key = `${asset}:${days}`;
    const cached = historyCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_MS) {
      return send(res, 200, cached.body);
    }

    const client = readClient();
    let spot: { price: number; updatedAt: string; feed: string } | null = null;
    let spotError: string | null = null;
    try {
      const feed = client.chainConfig.priceFeeds[asset];
      if (!feed) throw new Error(`No price feed configured for ${asset}`);
      // client.provider and client.chainConfig are public typed fields on
      // ThetanutsClient — no cast needed. Reading them here (rather than
      // inside spot.ts) is what keeps spot.ts free of the SDK.
      spot = await fetchSpot(feed, client.provider);
    } catch (e: any) {
      spotError = e?.shortMessage || e?.message || String(e);
      console.error('fetchSpot failed:', spotError);
    }

    let candles: Awaited<ReturnType<typeof fetchHistory>> = [];
    let historySource: 'coinbase-exchange' | null = null;
    let historyError: string | null = null;
    try {
      candles = await fetchHistory(asset, days);
      historySource = 'coinbase-exchange';
    } catch (e: any) {
      historyError = e?.message || String(e);
      console.error('fetchHistory failed:', historyError);
    }

    const body = {
      candles,
      spot: spot ? { ...spot, source: 'chainlink' as const } : null,
      historySource,
      // Surfaced, not just logged: a chart that silently drops its headline
      // number looks identical to one that never had it. The UI shows these
      // (Task 9) so a degraded chart is legibly degraded, never mistaken for
      // complete. Never a fabricated fallback price.
      spotError,
      historyError,
    };
    // Only cache a fully-successful response. Caching a degraded one pins the
    // failure for 60s — on a flaky RPC that turns one transient into a minute
    // of missing spot, which is exactly the wrong behavior mid-demo.
    if (spot && historySource) historyCache.set(key, { body, fetchedAt: Date.now() });
    return send(res, 200, body);
  }

```

Note this route is deliberately placed before the `req.method === 'GET'` static-file fallback but must be checked with its own `req.method === 'GET' && url === '/api/history'` guard (matching the existing pattern every other route uses), not folded into `serveStatic`.

- [ ] **Step 3: Manual verification (network route — no vitest coverage per repo convention)**

Run: `npm run web`, then in a separate terminal: `curl 'http://localhost:8787/api/history?asset=ETH&days=14'`
Expected: JSON with a non-empty `candles` array (each `{t,o,h,l,c}`), a `spot` object with a plausible ETH price and feed `0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70`, `historySource: "coinbase-exchange"`, and both `spotError` and `historyError` null.

Run: `curl 'http://localhost:8787/api/history?asset=DOGE&days=14'`
Expected: `400` with `{"error":"asset must be ETH or BTC"}`.

**Boundary check — this is the specific bug this task was rewritten to fix. Do not skip it:**

```bash
for d in 1 2 3 10 11 30 75 76 90; do
  echo -n "days=$d -> "
  curl -s "http://localhost:8787/api/history?asset=ETH&days=$d" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.candles.length+' candles, historyError='+j.historyError)})"
done
```

Expected: every one of the nine returns a non-empty `candles` array and `historyError=null`. Under the original fixed if/else ladder, `days=2` and `days=76`/`days=90` each returned `0 candles` with a Coinbase `400` ("Count of aggregations requested exceeds 300") — confirmed against the live API. If any row shows 0 candles, `granularityFor` is wrong; fix it rather than widening the clamp.

- [ ] **Step 4: Commit**

```bash
git add src/spot.ts src/server.ts tests/spot.test.ts
git commit -m "feat: /api/history route — Coinbase candles + Chainlink spot, 60s cached

granularityFor derives granularity from Coinbase's 300-candle request cap
rather than a fixed ladder, which returned HTTP 400 for 2-day and 76-90 day
windows. fetchSpot takes (feed, provider) so src/spot.ts imports no SDK, and
retries once against public-RPC rate limiting. Degraded responses carry an
explicit error string and are not cached."
```

---

## Task 9: Unified chart — candles, strike, spot, expiry marker, protected-zone shading

**Files:**
- Modify: `web/index.html` (replace `drawPayoff` with a new unified chart function; update the call sites and the SVG/legend markup)

**Interfaces:**
- Consumes: `GET /api/history?asset&days` (Task 8); `data.quote.strike`, `data.quote.expiryIso` (already returned by `/api/quote`, unchanged); `data.payoff` (already returned by `/api/quote`, unchanged — reused, not modified, in Task 10)

- [ ] **Step 1: Replace the chart's static markup**

Replace lines 413-425:

```html
  <!-- STEP 3: payoff -->
  <div class="step" id="step3">
    <div class="step-label"><span class="step-num">3</span> What happens at expiry</div>
    <div class="chart-wrap">
      <svg id="payoffChart" viewBox="0 0 600 260"></svg>
      <div class="chart-legend">
        <span><span class="dot" style="background:var(--accent)"></span> this put's own P/L at expiry, per contract held</span>
      </div>
    </div>
    <div id="step3CostCard" class="cost-summary-card" style="display:none;"></div>
    <p class="sentence" id="payoffSummary" style="margin-top:14px;"></p>
    <button class="btn" onclick="goToExecute()">Continue →</button>
  </div>
```

with:

```html
  <!-- STEP 3: unified price/payoff chart -->
  <div class="step" id="step3">
    <div class="step-label"><span class="step-num">3</span> Price, floor, deadline, and payoff — one picture</div>
    <div class="chart-wrap">
      <svg id="payoffChart" viewBox="0 0 700 320"></svg>
      <div class="chart-legend">
        <span><span class="dot" style="background:var(--accent)"></span> up candle</span>
        <span><span class="dot" style="background:var(--danger)"></span> down candle</span>
        <span><span class="dot" style="background:var(--warn); border-radius:2px;"></span> your floor (strike)</span>
        <span><span class="dot" style="background:var(--dim); border-radius:2px;"></span> spot now</span>
        <span><span class="dot" style="background:var(--accent)"></span> payoff at expiry (right edge)</span>
      </div>
      <div id="chartAttribution" style="font-size:11px; color:var(--dim); margin-top:6px;"></div>
    </div>
    <div id="step3CostCard" class="cost-summary-card" style="display:none;"></div>
    <p class="sentence" id="payoffSummary" style="margin-top:14px;"></p>
    <button class="btn" onclick="goToExecute()">Continue →</button>
  </div>
```

- [ ] **Step 2: Replace `drawPayoff` with a chart function that fetches history and draws the unified view**

Replace the whole `drawPayoff` function (lines 879-898):

```js
function drawPayoff(data) {
  const svg = document.getElementById('payoffChart');
  const W = 600, H = 260, PAD = 40;
  const pts = data.payoff;
  const strike = data.quote.strike;
  const lo = pts[0].spot, hi = pts[pts.length - 1].spot;
  const maxAbs = Math.max(...pts.map(p => Math.abs(p.pnl))) * 1.1 || 1;
  const xS = s => PAD + ((s - lo) / (hi - lo)) * (W - 2 * PAD);
  const yS = p => H / 2 - (p / maxAbs) * (H / 2 - 20);
  const path = 'M ' + pts.map(p => `${xS(p.spot).toFixed(1)},${yS(p.pnl).toFixed(1)}`).join(' L ');
  svg.innerHTML = `
    <line x1="${PAD}" y1="${H/2}" x2="${W-PAD}" y2="${H/2}" stroke="#232838" stroke-width="1"/>
    <line x1="${xS(strike)}" y1="20" x2="${xS(strike)}" y2="${H-20}" stroke="#3a4256" stroke-dasharray="4,4" stroke-width="1"/>
    <text x="${xS(strike)}" y="14" fill="#8892a6" font-size="11" text-anchor="middle" font-family="monospace">strike $${strike}</text>
    <line x1="${PAD}" y1="${yS(0)}" x2="${W-PAD}" y2="${yS(0)}" stroke="#8892a6" stroke-width="1.5" stroke-dasharray="3,3"/>
    <path d="${path}" fill="none" stroke="#4fd1a5" stroke-width="2.5"/>
    <text x="${PAD}" y="${H-6}" fill="#8892a6" font-size="10" font-family="monospace">$${lo.toFixed(0)}</text>
    <text x="${W-PAD}" y="${H-6}" fill="#8892a6" font-size="10" font-family="monospace" text-anchor="end">$${hi.toFixed(0)}</text>
  `;
}
```

with:

```js
/**
 * SVG presentation attributes, unlike CSS properties, are not reliably
 * var()-resolvable across browsers — which is why the original drawPayoff
 * hardcoded hex. Keep that. These MUST stay in sync with the :root custom
 * properties at the top of this file.
 */
const CHART_COLORS = {
  accent: '#4fd1a5',
  danger: '#ff6b6b',
  warn:   '#ffb84f',
  dim:    '#8892a6',
  grid:   '#232838',
  axis:   '#3a4256',
};

/** Monotonic token so a slow history fetch can't overwrite a newer candidate's chart. */
let chartRenderToken = 0;

/**
 * Fetches real price history + spot and draws it together with the strike,
 * expiry, protected zone, and the existing payoff curve. Degrades to
 * strike/spot/expiry/payoff only if the history fetch fails or returns no
 * candles — the chart never blocks the flow (design rule: no fabricated
 * numbers, so a missing input is dropped, never invented, and the drop is
 * stated on screen rather than left to look like completeness).
 */
async function drawUnifiedChart(data) {
  const asset = document.getElementById('asset').value;
  const days = Number(document.getElementById('days').value) || 14;
  const token = ++chartRenderToken;
  let history = { candles: [], spot: null, historySource: null, spotError: null, historyError: null };
  try {
    history = await apiGet('/api/history?asset=' + encodeURIComponent(asset) + '&days=' + days);
  } catch (e) {
    history.historyError = e.message;
    history.spotError = e.message;
    console.warn('history fetch failed, chart will degrade:', e.message);
  }
  // A user clicking through candidates fires overlapping fetches; without this
  // guard the slowest response wins and paints stale history over the newest
  // selection. Silently dropping a superseded render is correct here.
  if (token !== chartRenderToken) return;
  renderUnifiedChart(data, history, days);
}

/** GET wrapper — the existing api() helper is POST-only. */
async function apiGet(path) {
  const res = await fetch(path);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function renderUnifiedChart(data, history, historyDays) {
  const svg = document.getElementById('payoffChart');
  const W = 700, H = 320, PAD_L = 60, PAD_R = 130, PAD_T = 26, PAD_B = 34;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const strike = data.quote.strike;
  const expiryMs = new Date(data.quote.expiryIso).getTime();
  const nowMs = Date.now();
  const historyStartMs = nowMs - historyDays * 86400 * 1000;
  const candles = history.candles || [];
  const spot = history.spot;

  // X: history occupies the left ~70%, future (now -> expiry) the right ~30%.
  const historyFrac = 0.7;
  const xHistory = t => PAD_L + ((t - historyStartMs) / Math.max(1, nowMs - historyStartMs)) * (plotW * historyFrac);
  const xFuture = t => PAD_L + plotW * historyFrac + ((t - nowMs) / Math.max(1, expiryMs - nowMs)) * (plotW * (1 - historyFrac));
  const xForTime = t => (t <= nowMs ? xHistory(t) : xFuture(t));
  const xNow = PAD_L + plotW * historyFrac;
  const xExpiry = PAD_L + plotW;

  // Y: price, spanning candle highs/lows, strike, and spot, with padding.
  const candlePrices = candles.flatMap(c => [c.h, c.l]);
  const allPrices = [...candlePrices, strike, spot ? spot.price : strike].filter(Number.isFinite);
  const priceLo = Math.min(...allPrices) * 0.97;
  const priceHi = Math.max(...allPrices) * 1.03;
  const yS = p => PAD_T + (1 - (p - priceLo) / (priceHi - priceLo)) * plotH;

  const candleW = candles.length ? Math.max(1.5, (plotW * historyFrac / candles.length) * 0.6) : 0;
  const candleSvg = candles.map(c => {
    const x = xHistory(c.t * 1000);
    const up = c.c >= c.o;
    const color = up ? CHART_COLORS.accent : CHART_COLORS.danger;
    const bodyTop = yS(Math.max(c.o, c.c));
    const bodyBot = yS(Math.min(c.o, c.c));
    return `
      <line x1="${x}" y1="${yS(c.h)}" x2="${x}" y2="${yS(c.l)}" stroke="${color}" stroke-width="1"/>
      <rect x="${(x - candleW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${Math.max(1, bodyBot - bodyTop).toFixed(1)}" fill="${color}"/>
    `;
  }).join('');

  // Protected zone: below strike, from now to expiry.
  const protectedZone = strike > priceLo
    ? `<rect x="${xNow.toFixed(1)}" y="${yS(strike).toFixed(1)}" width="${(xExpiry - xNow).toFixed(1)}" height="${Math.max(0, yS(priceLo) - yS(strike)).toFixed(1)}" fill="rgba(79,209,165,0.08)"/>`
    : '';

  const strikeLine = `
    <line x1="${PAD_L}" y1="${yS(strike).toFixed(1)}" x2="${xNow.toFixed(1)}" y2="${yS(strike).toFixed(1)}" stroke="${CHART_COLORS.warn}" stroke-dasharray="4,4" stroke-width="1.5"/>
    <line x1="${xNow.toFixed(1)}" y1="${yS(strike).toFixed(1)}" x2="${(W - PAD_R).toFixed(1)}" y2="${yS(strike).toFixed(1)}" stroke="${CHART_COLORS.warn}" stroke-width="2"/>
    <text x="${(W - PAD_R + 6).toFixed(1)}" y="${(yS(strike) - 4).toFixed(1)}" fill="${CHART_COLORS.warn}" font-size="11" font-family="monospace">$${strike.toLocaleString()} floor</text>
  `;

  const spotLine = spot ? `
    <line x1="${PAD_L}" y1="${yS(spot.price).toFixed(1)}" x2="${(W - PAD_R).toFixed(1)}" y2="${yS(spot.price).toFixed(1)}" stroke="${CHART_COLORS.dim}" stroke-dasharray="2,3" stroke-width="1.5"/>
    <text x="${PAD_L}" y="${(yS(spot.price) - 4).toFixed(1)}" fill="${CHART_COLORS.dim}" font-size="11" font-family="monospace">$${spot.price.toLocaleString(undefined,{maximumFractionDigits:0})} now</text>
  ` : '';

  const pctBelowSpot = spot && spot.price > 0 ? (((spot.price - strike) / spot.price) * 100) : null;

  const expiryLine = `
    <line x1="${xExpiry.toFixed(1)}" y1="${PAD_T}" x2="${xExpiry.toFixed(1)}" y2="${(H - PAD_B).toFixed(1)}" stroke="${CHART_COLORS.axis}" stroke-dasharray="3,3" stroke-width="1"/>
    <text x="${xExpiry.toFixed(1)}" y="${(PAD_T - 8).toFixed(1)}" fill="${CHART_COLORS.dim}" font-size="10" text-anchor="end" font-family="monospace">exp ${data.quote.expiryIso.slice(0,10)}</text>
  `;
  const nowLine = `<line x1="${xNow.toFixed(1)}" y1="${PAD_T}" x2="${xNow.toFixed(1)}" y2="${(H - PAD_B).toFixed(1)}" stroke="${CHART_COLORS.grid}" stroke-width="1"/>`;

  // Payoff gutter on the right edge: transpose payoffCurve (spot on Y, pnl on X), sharing the price axis.
  //
  // CRITICAL: /api/quote returns the payoff over [strike*0.8, strike*1.2]
  // (server.ts's payoffCurve call), but this chart's Y domain is driven by
  // candles/strike/spot and is typically far narrower — often ~6-15% wide vs
  // the payoff's 40%. Mapping every payoff point through the shared yS()
  // therefore sends the endpoints hundreds of pixels outside a 320-tall
  // viewBox (for strike 2400 with a 2280-2680 band the endpoints land at
  // y=520 and y=-106), so most of the curve silently vanishes and what
  // remains reads as a near-vertical stub.
  //
  // Fix: draw only the portion of the payoff that covers prices actually on
  // screen, and clip as a backstop. This is honest — it shows the P/L across
  // the visible price range — and requires no new math, so the no-fabricated-
  // numbers rule holds: every point still comes straight from the server.
  const visiblePts = data.payoff.filter(p => p.spot >= priceLo && p.spot <= priceHi);
  const gutterX0 = W - PAD_R + 24;
  const gutterW = PAD_R - 30;
  let gutterSvg = '';
  let gutterZero = gutterX0 + gutterW / 2;
  if (visiblePts.length >= 2) {
    const maxAbsPnl = Math.max(...visiblePts.map(p => Math.abs(p.pnl))) * 1.1 || 1;
    const gx = pnl => gutterX0 + gutterW / 2 + (pnl / maxAbsPnl) * (gutterW / 2);
    gutterZero = gx(0);
    const gutterPath = 'M ' + visiblePts.map(p => `${gx(p.pnl).toFixed(1)},${yS(p.spot).toFixed(1)}`).join(' L ');
    gutterSvg = `<path d="${gutterPath}" fill="none" stroke="${CHART_COLORS.accent}" stroke-width="2" clip-path="url(#plotClip)"/>`;
  }

  svg.innerHTML = `
    <defs>
      <clipPath id="plotClip">
        <rect x="0" y="${PAD_T}" width="${W}" height="${plotH}"/>
      </clipPath>
    </defs>
    ${protectedZone}
    <g clip-path="url(#plotClip)">${candleSvg}</g>
    ${strikeLine}
    ${spotLine}
    ${nowLine}
    ${expiryLine}
    <line x1="${gutterZero.toFixed(1)}" y1="${PAD_T}" x2="${gutterZero.toFixed(1)}" y2="${(H - PAD_B).toFixed(1)}" stroke="${CHART_COLORS.dim}" stroke-width="1" stroke-dasharray="2,2"/>
    ${gutterSvg}
    <text x="${gutterX0.toFixed(1)}" y="${(H - 10).toFixed(1)}" fill="${CHART_COLORS.dim}" font-size="9" font-family="monospace">payoff</text>
  `;

  // Attribution — four numbers, four named sources (design rule 3). A missing
  // input is stated in place, never quietly omitted: a chart that lost its
  // spot line must not look identical to one that never had a spot line.
  const attribution = document.getElementById('chartAttribution');
  const spotText = spot
    ? `spot $${spot.price.toLocaleString(undefined,{maximumFractionDigits:0})} (Chainlink, ${new Date(spot.updatedAt).toLocaleTimeString()})` +
      (pctBelowSpot !== null ? ` · floor is ${pctBelowSpot.toFixed(1)}% below spot` : '')
    : 'SPOT UNAVAILABLE — no live price to compare your floor against';
  const historyText = history.historySource ? 'candles: Coinbase' : 'CANDLES UNAVAILABLE';
  attribution.textContent = `${historyText} · ${spotText} · strike: live Thetanuts order · payoff: previewFillOrder()`;
  attribution.style.color = (spot && history.historySource) ? 'var(--dim)' : 'var(--warn)';
  if (history.spotError || history.historyError) {
    console.warn('chart degraded —', { spotError: history.spotError, historyError: history.historyError });
  }
}
```

- [ ] **Step 3: Update the call site**

`selectCandidate` calls `drawPayoff(data)` at line 767. Replace:

```js
    setStep(3);
    drawPayoff(data);
```

with:

```js
    setStep(3);
    drawUnifiedChart(data);
```

`drawUnifiedChart` is `async` but not awaited here deliberately — the rest of `selectCandidate` (cost card, summary text) doesn't depend on the chart finishing, and the chart renders itself once its fetch resolves.

- [ ] **Step 4: Manual verification**

Run: `npm run web`, open `http://localhost:8787`, run the flow through step 2 into step 3.
Expected: candles render on the left ~70% of the chart width, a dashed-then-solid amber strike line runs across, a dotted grey spot line sits at the current price with a "X% below spot" annotation, a vertical expiry marker sits at the right edge, the region below strike/right of now is faintly shaded green, and the accent-green payoff curve appears in a narrow gutter on the right sharing the same price axis. Confirm the attribution line under the chart names Coinbase, Chainlink, Thetanuts, and `previewFillOrder()`.

**Explicitly check the payoff gutter is actually on screen** — this was the defect that made the earlier draft of this task wrong. In devtools, inspect the gutter `<path>` and confirm every `y` coordinate in its `d` attribute falls between `PAD_T` (26) and `H - PAD_B` (286). A `y` of 500+ or a negative `y` means the visible-band filter isn't being applied and the curve is being drawn outside the viewBox. The curve should show a visible kink where it crosses the strike line's height, with both a sloped and a flat segment present.

Test the degrade path: temporarily block `api.exchange.coinbase.com` (e.g. via browser devtools' network request blocking) and reload step 3.
Expected: chart still shows strike, spot (if Chainlink still reachable), expiry, protected zone, and payoff gutter — no candles, no crash, no blocked flow, and the attribution line turns amber and reads "CANDLES UNAVAILABLE" rather than silently omitting the source.

Test the race guard: click rapidly between three candidates in step 2. Expected: the chart that settles matches the candidate that stays selected — no flicker to a previous candidate's history.

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat: unified candlestick + strike/spot/expiry/payoff chart"
```

---

## Task 10: Correctness tier — debounce input, distance-gated "closest match" badge, honest far-miss copy

**Files:**
- Modify: `web/index.html` (step-2 markup, `onConstraintChange`, `findFloors`, `renderCandidates`)

**Interfaces:**
- Consumes: `pctFromImpliedStrike` (absolute) and `pctVsImpliedStrike` (signed) from `toWire` (Task 4)

- [ ] **Step 1: Give the far-miss warning and the staleness notice their own elements**

The far-miss copy CANNOT be written into `#candVerdict`. `renderCandidates` ends by calling `selectCandidate`, which immediately overwrites `#candVerdict` with a spinner and then the quote verdict — so a warning written there is destroyed milliseconds after it appears, and the flagship "'closest match' is a lie" fix would never be visible. It needs a separate element, declared above the verdict.

In the step-2 block, replace:

```html
    <div class="candidate-list" id="candidateList" style="display:none;"></div>
    <div class="verdict" id="candVerdict" style="display:none;"></div>
```

with:

```html
    <div class="verdict" id="candStale" style="display:none;"></div>
    <div class="candidate-list" id="candidateList" style="display:none;"></div>
    <div class="verdict" id="candFarMiss" style="display:none;"></div>
    <div class="verdict" id="candVerdict" style="display:none;"></div>
```

- [ ] **Step 2: Debounce the constraint-change handler so it stops firing a quote per keystroke, and detect a stale list**

Debouncing alone is not enough. Before this plan, `renderCandidates` recomputed its dollar figure client-side, so an edited floor at least updated the numbers. After Task 4 the distance lives in `pctFromImpliedStrike`, **baked server-side at fetch time** — so re-rendering the same array against an edited floor would show badges measured against the *old* implied strike. That is a worse lie than the one being fixed. Detect the change and say so instead of re-rendering silently.

Add near the top-level `state` declaration:

```js
/** The spec the current candidate list was actually fetched for. */
state.candidatesSpec = null;
```

and set it in `findFloors`, immediately after a successful fetch (`state.candidates = candidates;`):

```js
    state.candidatesSpec = currentSpec();
    document.getElementById('candStale').style.display = 'none';
```

Replace (around line 653-662):

```js
function onConstraintChange() {
  restateSentence();
  if (state.candidates.length > 0) {
    renderCandidates(state.candidates);
  }
}

['asset','amount','floor','days'].forEach(id =>
  document.getElementById(id).addEventListener('input', onConstraintChange)
);
```

with:

```js
let constraintChangeTimer = null;

function specsMatch(a, b) {
  return !!a && !!b && a.asset === b.asset && a.quantity === b.quantity
    && a.floorTotalUsd === b.floorTotalUsd && a.horizonDays === b.horizonDays;
}

function onConstraintChange() {
  restateSentence(); // immediate — this is the live per-unit readout, never debounced
  if (constraintChangeTimer) clearTimeout(constraintChangeTimer);
  constraintChangeTimer = setTimeout(() => {
    if (!state.candidates.length) return;
    const stale = document.getElementById('candStale');
    if (specsMatch(state.candidatesSpec, currentSpec())) {
      stale.style.display = 'none';
      renderCandidates(state.candidates);
      return;
    }
    // Constraint changed since these offers were fetched. Their strike
    // distances were computed server-side against the OLD implied strike, so
    // re-rendering would show badges measuring the wrong thing. Say so and
    // leave the list untouched until the user re-queries the live book.
    const old = state.candidatesSpec;
    stale.style.display = 'block';
    stale.innerHTML = `<b>These offers are out of date.</b> They were matched against ` +
      `$${(old.floorTotalUsd / old.quantity).toLocaleString(undefined,{maximumFractionDigits:2})} per ${old.asset} ` +
      `(${old.quantity} ${old.asset} · $${old.floorTotalUsd.toLocaleString()} total · ${old.horizonDays}d). ` +
      `Click <b>Find real offers</b> again to re-query the live book for your new constraint.`;
  }, 400);
}

['asset','amount','floor','days'].forEach(id =>
  document.getElementById(id).addEventListener('input', onConstraintChange)
);
```

- [ ] **Step 3: Stop resetting the selection to candidate 0 on every re-render**

`renderCandidates` currently always calls `selectCandidate(0, el.children[0])` at line 748, discarding whatever the user had selected. Replace the end of `renderCandidates` (around line 728-749):

```js
function renderCandidates(list) {
  const el = document.getElementById('candidateList');
  el.innerHTML = '';
  const heldAmount = Number(document.getElementById('amount').value) || 1;
  const asset = document.getElementById('asset').value;
  list.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'candidate';
    div.onclick = () => selectCandidate(i, div);
    const gapBadge = c.coverageGapDays > 0.25
      ? `<span class="badge warn">ends ${c.coverageGapDays.toFixed(1)}d early</span>` : '';
    const bestBadge = i === 0 ? '<span class="badge good">closest match</span>' : '';
    const totalCost = (c.pricePerContract * heldAmount).toFixed(2);
    div.innerHTML = `
      <div>
        <div class="strike">$${c.strike.toLocaleString()} floor ${bestBadge}${gapBadge}</div>
        <div class="meta">${c.daysToExpiry.toFixed(1)}d window · exp ${c.expiryIso.slice(0,10)} · put, buyable · iv ${c.iv ? c.iv.toFixed(2) : '—'}</div>
      </div>
      <div class="premium">
        <div class="amount">$${totalCost} USDC</div>
        <div class="label">total cost for ${heldAmount} ${asset} ($${c.pricePerContract.toFixed(2)}/ea)</div>
      </div>
    `;
    el.appendChild(div);
  });
  selectCandidate(0, el.children[0]);
}
```

with:

```js
/** A candidate further than this from the user's implied strike doesn't earn the "closest match" badge. */
const CLOSEST_MATCH_MAX_PCT = 15;

/** Human-readable direction for a signed distance. */
function strikeDirection(pctVs) {
  return pctVs >= 0 ? 'below' : 'above';
}

function renderCandidates(list) {
  const el = document.getElementById('candidateList');
  const previouslySelectedId = state.selected?.id;
  el.innerHTML = '';
  const asset = document.getElementById('asset').value;
  list.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'candidate';
    div.onclick = () => selectCandidate(i, div);
    const gapBadge = c.coverageGapDays > 0.25
      ? `<span class="badge warn">ends ${c.coverageGapDays.toFixed(1)}d early</span>` : '';
    // Gate on ABSOLUTE distance. filterCandidates ranks by absolute distance,
    // so list[0] can sit far ABOVE the user's floor when the book has nothing
    // near it — a strike 30% above is a real mismatch (it costs far more than
    // asked), not a perfect one. Label with the signed value so the user can
    // see which side of their floor it falls on.
    const isClose = c.pctFromImpliedStrike <= CLOSEST_MATCH_MAX_PCT;
    const bestBadge = i === 0 && isClose ? '<span class="badge good">closest match</span>' : '';
    const farBadge = i === 0 && !isClose
      ? `<span class="badge warn">${c.pctFromImpliedStrike.toFixed(0)}% ${strikeDirection(c.pctVsImpliedStrike)} your floor</span>`
      : '';
    div.innerHTML = `
      <div>
        <div class="strike">$${c.strike.toLocaleString()} floor ${bestBadge}${farBadge}${gapBadge}</div>
        <div class="meta">${c.daysToExpiry.toFixed(1)}d window · exp ${c.expiryIso.slice(0,10)} · put, buyable · iv ${c.iv ? c.iv.toFixed(2) : '—'}</div>
      </div>
      <div class="premium">
        <div class="amount">$${c.pricePerContract.toFixed(2)}/${asset}</div>
        <div class="label">confirmed cost shown after you pick</div>
      </div>
    `;
    el.appendChild(div);
  });

  // The far-miss warning goes in its OWN element. selectCandidate (called at
  // the end of this function) overwrites #candVerdict with a spinner and then
  // the quote verdict, so anything written there would be gone in milliseconds.
  const farMiss = document.getElementById('candFarMiss');
  if (!list.length) { farMiss.style.display = 'none'; return; }
  const nearest = list[0];
  if (nearest.pctFromImpliedStrike > CLOSEST_MATCH_MAX_PCT) {
    farMiss.style.display = 'block';
    farMiss.innerHTML = `<b>Nothing on the live book is close to your stated floor.</b> ` +
      `Your $${nearest.impliedStrike.toLocaleString(undefined,{maximumFractionDigits:2})} per-${asset} floor's ` +
      `nearest match is $${nearest.strike.toLocaleString()} — ${nearest.pctFromImpliedStrike.toFixed(0)}% ` +
      `${strikeDirection(nearest.pctVsImpliedStrike)} what you asked for. Payung shows it rather than hiding it, ` +
      `but this is not a good match. Try a floor closer to spot.`;
  } else {
    farMiss.style.display = 'none';
  }

  const restoreIndex = previouslySelectedId ? list.findIndex(c => c.id === previouslySelectedId) : -1;
  const indexToSelect = restoreIndex >= 0 ? restoreIndex : 0;
  selectCandidate(indexToSelect, el.children[indexToSelect]);
}
```

Also clear `#candFarMiss` and `#candStale` in `resetFlow()` alongside the other step resets, and reset `state.candidatesSpec = null` there — otherwise a stale banner survives "start over".

Note: this removes the client-side `pricePerContract * heldAmount` total from the candidate list (Honesty tier item 7 from the design doc — folded in here since it's the same lines being touched) — the list now shows only the server-provided `$/unit` rate, and the confirmed total appears after `selectCandidate` fetches the real quote, same as it already does in the Step 3 cost card.

- [ ] **Step 4: Manual verification**

Run: `npm run web`, open the app.

*Debounce:* typing quickly in the Floor field no longer fires a flurry of "pricing with previewFillOrder()..." spinners — only one, ~400ms after typing stops.

*Selection persistence:* select the third candidate, then re-trigger the debounce without changing the spec (type a character in Floor and delete it, returning to the same value). The third candidate stays selected rather than snapping to index 0.

*Staleness:* select a candidate, then change Floor to a genuinely different value. Expected: the amber "These offers are out of date" banner appears above the list, naming the old per-unit floor, and the list is left as-is — no badge silently re-measured against the new floor. Clicking "Find real offers" clears it.

*Far miss (below):* set Amount=1, Floor=1000, Days=14 — an implied $1,000/ETH floor, roughly 60% under spot, far from anything the book quotes. Expected: no green "closest match"; an amber "N% below your floor" badge instead, and the `#candFarMiss` block explains it. **Confirm the warning is still on screen after the quote resolves** — that is the specific regression this step exists to prevent, since it previously shared an element with the verdict and was overwritten instantly.

*Far miss (above):* set Floor to a value well *above* spot (e.g. Amount=1, Floor=6000). Expected: the far-miss warning still fires and reads "above your floor". Under the earlier clamped `Math.max(0, …)` distance this case scored 0% and wrongly earned a green "closest match".

Note: do **not** use "0.32 ETH / $798 total" as the far-miss case. Post-fix that implies a ~$2,494/ETH floor — close to spot and a perfectly good match. It is the *regression* case for Task 6, not a far-miss case.

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "fix: debounce constraint edits, gate 'closest match' on absolute distance, flag stale candidate lists, drop client-computed premium

The far-miss warning gets its own element: it previously shared #candVerdict
with the quote verdict, which selectCandidate overwrites milliseconds later.
Distance now gates on absolute deviation — clamping negatives to zero badged
a strike far ABOVE the requested floor as a perfect match."
```

---

## Task 11: Honesty tier — coverage gap in the summary sentence, verdict severity styling, capped-coverage shortfall promoted to a headline

**Files:**
- Modify: `web/index.html` (`selectCandidate`'s verdict/summary rendering, `.verdict` CSS)

- [ ] **Step 1: Style verdict severity**

In the `<style>` block, replace the existing `.verdict` rule (around lines 192-200):

```css
  .verdict {
    margin-top: 14px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px dashed var(--border);
    font-size: 13px;
    color: var(--dim);
  }
  .verdict b { color: var(--text); }
```

with:

```css
  .verdict {
    margin-top: 14px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px dashed var(--border);
    font-size: 13px;
    color: var(--dim);
  }
  .verdict b { color: var(--text); }
  .verdict.reasonable { border: 1px solid var(--accent-dim); background: rgba(79,209,165,0.06); }
  .verdict.reasonable b { color: var(--accent); }
  .verdict.expensive { border: 1px solid #6b5a2a; background: rgba(255,184,79,0.06); }
  .verdict.expensive b { color: var(--warn); }
  .verdict.not-worth-it { border: 1px solid #6b2a2a; background: rgba(255,107,107,0.08); }
  .verdict.not-worth-it b { color: var(--danger); }
```

- [ ] **Step 2: Apply the severity class and expand the summary sentence**

In `selectCandidate` (around lines 751-821), the verdict block currently does:

```js
    state.quote = data;
    verdict.innerHTML = `<b>Agent verdict: ${data.judgment.verdict.replace(/-/g, ' ')}.</b> ` +
      data.judgment.reasons.map(r => r).join(' ');
    setStep(3);
```

Replace with:

```js
    state.quote = data;
    verdict.className = 'verdict ' + data.judgment.verdict;
    verdict.innerHTML = `<b>Agent verdict: ${data.judgment.verdict.replace(/-/g, ' ')}.</b> ` +
      data.judgment.reasons.map(r => r).join(' ');
    setStep(3);
```

And further down, the `payoffSummary` block currently reads:

```js
    const coverageNote = heldAmount > 0
      ? ` This covers <b>${q.contracts.toFixed(4)}</b> of your <b>${heldAmount}</b> ${asset} — the rest is unprotected.`
      : '';
    document.getElementById('payoffSummary').innerHTML =
      `You spend exactly <b>$${q.spendUsdc.toFixed(2)} USDC</b>${capNote} — that is your maximum loss; nothing more can ever be taken. ` +
      `If the price is below <b>$${q.strike.toLocaleString()}</b> at expiry (${q.expiryIso.slice(0,10)}), the contract pays you the difference in cash — your real coins are never sold. ` +
      `If it stays above, the contract expires and you are out the premium — but your coins are worth more anyway.${coverageNote}`;
```

Replace with (adds the coverage-gap sentence and promotes a large capped shortfall):

```js
    const coveragePct = heldAmount > 0 ? (q.contracts / heldAmount) * 100 : 100;
    const coverageNote = heldAmount > 0
      ? ` This covers <b>${q.contracts.toFixed(4)}</b> of your <b>${heldAmount}</b> ${asset}` +
        (coveragePct < 50
          ? ` — <b style="color:var(--danger)">only ${coveragePct.toFixed(0)}% of what you asked to protect; the rest is unprotected.</b>`
          : ` — the rest is unprotected.`)
      : '';
    const gapDays = state.selected?.coverageGapDays ?? 0;
    const coverageGapNote = gapDays > 0.25
      ? ` <b style="color:var(--warn)">Protection ends ${gapDays.toFixed(1)} days before your stated deadline</b> — after ${q.expiryIso.slice(0,10)} you are unprotected again.`
      : '';
    document.getElementById('payoffSummary').innerHTML =
      `You spend exactly <b>$${q.spendUsdc.toFixed(2)} USDC</b>${capNote} — that is your maximum loss; nothing more can ever be taken. ` +
      `If the price is below <b>$${q.strike.toLocaleString()}</b> at expiry (${q.expiryIso.slice(0,10)}), the contract pays you the difference in cash — your real coins are never sold. ` +
      `If it stays above, the contract expires and you are out the premium — but your coins are worth more anyway.${coverageNote}${coverageGapNote}`;
```

- [ ] **Step 3: Manual verification**

Run: `npm run web`, walk the flow to step 3 for a floor that produces a `not-worth-it` verdict (e.g. a floor very close to spot) and for one producing `reasonable`.
Expected: the verdict box is visually distinct — red-tinted border/text for `not-worth-it`, green for `reasonable`, amber for `expensive` — not the same grey dashed box for all three. Pick a candidate with a real coverage gap (`coverageGapDays > 0.25`, visible from its step-2 amber pill) and confirm `payoffSummary` now states the gap explicitly, not just the step-2 badge.

- [ ] **Step 4: Commit**

```bash
git add web/index.html
git commit -m "feat: verdict severity styling; coverage gap and shortfall promoted into the summary sentence"
```

---

## Task 12: Polish tier — step-2 retry, keyboard-accessible candidates, rename `.mock-banner`

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Add a retry button on step-2 fetch failure**

Replace the `catch` block in `findFloors` (around lines 718-720):

```js
  } catch (e) {
    document.getElementById('candLoading').textContent = 'Error: ' + e.message;
  }
```

with:

```js
  } catch (e) {
    const loadingEl = document.getElementById('candLoading');
    loadingEl.innerHTML = `Error: ${e.message} <button class="btn secondary" style="margin-left:10px; padding:4px 10px; font-size:12px;" onclick="findFloors()">Retry</button>`;
  }
```

- [ ] **Step 2: Make candidates keyboard-accessible**

In `renderCandidates` (touched already in Task 10 — apply this on top of that version), change the `div.className = 'candidate'` block to add `tabindex`, `role`, and a keydown handler, and add a focus style in CSS.

In the `<style>` block, add after the existing `.candidate:hover`/`.candidate.selected` rules (around line 174-175):

```css
  .candidate:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

In `renderCandidates`'s `list.forEach` loop, change:

```js
    const div = document.createElement('div');
    div.className = 'candidate';
    div.onclick = () => selectCandidate(i, div);
```

to:

```js
    const div = document.createElement('div');
    div.className = 'candidate';
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.onclick = () => selectCandidate(i, div);
    div.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCandidate(i, div); }
    };
```

- [ ] **Step 3: Rename `.mock-banner`**

Replace line 361 (`<div class="mock-banner">`) with `<div class="live-banner">`, and rename the corresponding CSS rule (around lines 304-314) from `.mock-banner { ... }` to `.live-banner { ... }`.

- [ ] **Step 4: Manual verification**

Run: `npm run web`. Tab through the page with the keyboard from the Floor input onward; confirm each candidate card receives a visible focus ring and Enter/Space selects it. Temporarily stop the server mid-request (or throttle network to force a failure) to confirm the step-2 error state now shows a working Retry button.

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "polish: retry on step-2 fetch failure, keyboard-accessible candidates, rename stale .mock-banner class"
```

---

## Task 13: Update `HANDOFF.md` — remove the stale duplicate-fill finding, document the new spec shape

**Files:**
- Modify: `HANDOFF.md`

- [ ] **Step 1: Remove the stale "Known residual issue #1"**

`HANDOFF.md`'s "Known residual issues" section (starting around line 158) opens with an issue claiming `runSimulate()` unconditionally re-arms `execBtn`. This was verified false during this plan's design phase — `runSimulate()` (as of this plan's Task 10/11 edits, and already true before them) never touches `execBtn`; only `rearmExecute()`/`resetFlow()` do. Delete the entire "### 1. UNRESOLVED — a real safety gap in the web UI's execute/simulate interaction" subsection (from its heading through the paragraph ending "...an avoidable, embarrassing mistake."), and renumber the remaining two subsections ("First real on-chain fill has not been executed" becomes "### 1.", "Minor, deferred, non-blocking" becomes "### 2.").

- [ ] **Step 2: Document the new `ProtectionSpec` shape**

In the `### src/core.ts — the one module that matters most` section, find the line describing `ProtectionSpec`:

```
- `ProtectionSpec` (type) — `{asset: 'ETH'|'BTC', floorUsd, horizonDays}`, the parsed user intent.
```

Replace with:

```
- `ProtectionSpec` (type) — `{asset: 'ETH'|'BTC', quantity, floorTotalUsd, horizonDays}`, the parsed user intent. Defined in `src/spec.ts` and re-exported from this file, so existing `from './core.js'` imports keep working. `floorTotalUsd` is the TOTAL value the whole holding must be worth, never a per-unit price — the per-unit strike a match is ranked against is derived via `impliedStrike(spec) = floorTotalUsd / quantity`. Do not add a second stored per-unit field; every caller reads `impliedStrike`, so the total and per-unit readings can never drift apart (this fixed a real matching bug where "$798 for 0.32 ETH" was matched against an $798 strike instead of the correct $2,493.75).
```

- [ ] **Step 2b: Add the two new modules to the code-structure tree, with their reasons**

Both new modules exist to satisfy a design rule that isn't visible from their contents. Without the note, a future agent will "simplify" them back and silently break rule 1. In the `src/` tree in the "Code structure" section, add:

```
  spec.ts       — ProtectionSpec + impliedStrike. ZERO imports, deliberately: intent.ts needs
                  impliedStrike at RUNTIME, and rule 1 forbids it value-importing core.ts.
                  Do NOT merge this back into core.ts.
  spot.ts       — Coinbase candle history + Chainlink spot for the chart. Must never import the
                  Thetanuts SDK, not even as a type; takes (feed, provider) as plain arguments.
```

Then amend design rule 1 in the "Design rules that must never be violated" section. It currently says `intent.ts` and `judgment.ts` import only *types* from `core` — still true, and now add: they may value-import `spec.ts`, which is dependency-free by construction. Note in the same rule that `spot.ts` reaches the chain through an `ethers.Provider` handed to it by `server.ts`, never through the SDK.

- [ ] **Step 2c: Record the verified Chainlink fact**

Add to the "Confirmed technical facts" list (matching the style of the existing entries, which cite live verification): `chainConfig.priceFeeds.ETH` (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`) and `.BTC` (`0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F`) are genuine Chainlink AggregatorV3 proxies on Base — both answer `latestRoundData()` and `decimals()` (8), ETH's `description()` returns "ETH / USD". This is what makes the chart's spot marker the actual settlement price rather than a second opinion. Also note that the public `mainnet.base.org` RPC rate-limits these reads under light load (observed: "missing revert data" on a call that succeeded seconds earlier), which is why `fetchSpot` retries once.

Update the CLI description line similarly — find:

```
- `cli.ts` — Terminal interface: book, whoami, quote, simulate, execute, preflight, deposit, ask
```

This line itself doesn't need changes, but the "How to run it" section's example commands (if any reference the old 2-arg `quote`/`simulate`/`execute` shape) should be checked and updated to the 3-4 arg shape from Task 5. Search `HANDOFF.md` for `npm run quote --`, `npm run simulate --`, `npm run execute --`, `npm run preflight --` and update any found to match Task 5's new usage banner.

- [ ] **Step 3: Manual verification**

Read through the edited `HANDOFF.md` once to confirm no reference to `floorUsd` (singular, old shape) remains, and no reference to the now-fixed `runSimulate()` bug remains.

- [ ] **Step 4: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: HANDOFF.md reflects the new quantity+total ProtectionSpec and drops the stale runSimulate finding"
```

---

## Task 14: Full-suite verification and final walkthrough

**Files:** none (verification only)

- [ ] **Step 1: Full automated verification**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass; the only `tsc` error is the single pre-existing, out-of-scope `chainConfig.contracts.optionBook: string | null` in `src/core.ts` noted in the Global Constraints section. If any other error appears, find and fix the task that introduced it before proceeding.

Baseline for comparison: **49 tests across 9 files were green before this plan started.** This plan adds `tests/implied-strike.test.ts` and `tests/spot.test.ts` and extends `filter`/`intent`/`wire` — so the count must go *up*. A lower count means a file stopped being collected, not that tests were consolidated.

- [ ] **Step 1b: Confirm the architecture rules still hold mechanically**

```bash
grep -n "thetanuts-client" src/spot.ts          # must print nothing
grep -n "^import" src/spec.ts                    # must print nothing
grep -rn "from './core.js'" src/intent.ts        # must print nothing (it imports ./spec.js)
grep -rn "floorUsd" src/ tests/ web/ README.md docs/   # must print nothing
```

All four must come back empty. The first three are the design-rule-1 guards; the fourth confirms the rename is complete, including `README.md:33` and the `src/server.ts:154` comment that the original draft of this plan wrongly asserted did not exist.

- [ ] **Step 1c: Confirm the Coinbase granularity fix holds across the whole allowed range**

With `npm run web` running, run the nine-day-count loop from Task 8 Step 3 again. Every row must show a non-empty `candles` array and `historyError=null`. This is the one defect in this plan's earlier draft that failed silently rather than loudly — a 400 from Coinbase produced an empty chart, not an error the user or the developer would notice.

- [ ] **Step 2: End-to-end manual walkthrough**

Run: `npm run web`, open `http://localhost:8787`.

Walk the full flow once with the original regression case: type "I have 0.32 ETH and need it worth at least $798 in two weeks" into the NL box, click Parse, confirm Amount/Floor/Days fill correctly and the restated sentence shows "$2,493.75 per ETH". Click through to candidates, confirm the unified chart renders candles + strike + spot + expiry + protected zone + payoff gutter, confirm the verdict box is colored by severity, confirm the coverage-gap sentence appears if applicable, and confirm the candidate list no longer shows a client-computed total.

Then confirm the five defects this plan was revised to close are actually closed, since each of them fails quietly rather than crashing:

1. **Payoff gutter on screen** — inspect the gutter `<path>`; every `y` in its `d` must fall within 26–286. (Was: endpoints at y≈520 and y≈−106, outside a 320-tall viewBox.)
2. **Far-miss warning survives the quote** — with Floor=1000, the `#candFarMiss` text must still be visible *after* the verdict finishes loading. (Was: written into `#candVerdict`, overwritten by `selectCandidate` immediately.)
3. **Far-miss fires above the floor too** — with Floor=6000, expect an amber "% above your floor" badge, not green "closest match". (Was: `Math.max(0, …)` scored every above-floor strike as 0%.)
4. **Stale list is flagged** — edit Floor after fetching; expect the "out of date" banner, not silently re-measured badges.
5. **`days=2` returns candles** — set Days=2 and reach step 3; the chart must show candles. (Was: Coinbase 400, empty chart, server-side log only.)

Run: `npm run quote -- 0.32 798 5 14`
Expected: CLI confirms the same implied strike ($2,493.75) the web UI computed.

- [ ] **Step 3: Final commit (if the walkthrough surfaced any fixes)**

If Step 2 surfaced no issues, this task requires no commit — verification only. If it did surface issues, fix them within the task whose file they belong to, re-run Step 1, and commit with a message describing the fix (not folded into a prior task's commit).
