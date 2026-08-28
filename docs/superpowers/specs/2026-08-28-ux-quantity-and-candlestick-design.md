# UX design: total-value floor + unified candlestick/payoff chart

**Status:** approved by user 2026-08-28, ready for implementation planning.
**Classification:** architectural (brainstorming skill) — touches `ProtectionSpec`, the safety-critical filter, the CLI's public argument shape, and adds a new data source (price history) the repo has never had.

---

## 1. Problem statement

Two problems, discovered together while investigating a UX request:

### 1a. `floorUsd` is ambiguous and the two halves of the system disagree about what it means

- The **matching logic** treats it as a per-unit strike: `Candidate.strike` is price-per-1-unit ([src/core.ts:107](../../../src/core.ts#L107)), and `filterCandidates` ranks by `Math.abs(a.strike - spec.floorUsd)` ([src/core.ts:181](../../../src/core.ts#L181)). The web form agrees — the field is labeled "Floor price you need ($)" ([web/index.html:391](../../../web/index.html#L391)).
- The **AI and the restated sentence** treat it as a total portfolio value: the system prompt defines `floorUsd` as "the minimum USD **value** they need" ([src/intent.ts:38](../../../src/intent.ts#L38)), and the UI reads it back as *"I have 0.32 ETH. I need it to be worth at least $798"* — total framing ([web/index.html:650](../../../web/index.html#L650)).

Concrete failure: the sentence *"I have 0.32 ETH, need it worth $798 in 14 days"* produces `floorUsd: 798`. The filter then hunts for an ETH put with strike near **$798** — ~68% below spot — either finding nothing or returning the book's lowest strikes, badged `closest match` with high confidence. The correct strike is `798 / 0.32 = $2,493.75`. This is a silently-wrong number reaching the user, which is exactly what this codebase's own design rules (`HANDOFF.md` rule 3: "no fabricated numbers, anywhere") exist to prevent.

Separately, `amount` (quantity) is currently presentation-only — `currentSpec()` never sends it to the server ([web/index.html:693](../../../web/index.html#L693)) — even though it's required to resolve the ambiguity above.

### 1b. No spot price or price history exists anywhere in the system

The payoff chart's x-axis is `[strike * 0.8, strike * 1.2]` ([src/server.ts:189](../../../src/server.ts#L189)) — anchored to the strike, not the market. Nothing tells the user where the asset is trading now. But `PROJECT.md`'s entire pricing intuition ("the closer your floor is to today's price, the more it costs, ~10x across the table") depends on a variable — distance from spot — that is currently invisible in the product.

---

## 2. Decisions (from brainstorming with the user)

1. **Floor basis: total value + quantity.** `ProtectionSpec` becomes `{asset, quantity, floorTotalUsd, horizonDays}`. The per-unit strike a user needs is *derived*, never stored, so the two readings can't drift apart.
2. **Price source: Coinbase candles + Chainlink spot.** History (candlestick OHLC) comes from Coinbase Exchange's public candles endpoint (no key, no CORS problem, one cached server-side fetch). The live spot marker comes from `latestRoundData()` on the *same* Chainlink feed the candidate settles against (`candidate.priceFeed` — the identical feed `findCandidates` already matches on). This is the one combination where every number on the chart traces to a named, real source, matching design rule 3.
3. **Chart layout: one unified chart.** A single price-vs-time view: candles (real history) on the left, a horizontal strike line and vertical expiry marker on the right, a shaded "protected" region below-strike/after-today, and the existing payoff curve as a narrow rotated gutter on the right edge sharing the same price axis. This is harder to build than two stacked charts but puts every variable in the user's stated sentence (floor, deadline, spot, and P/L) into one picture.
4. **Findings scope: all three tiers (correctness, honesty, polish).** See §5.

---

## 3. Data model changes

### 3.1 `ProtectionSpec` (src/core.ts)

```ts
export type ProtectionSpec = {
  asset: 'ETH' | 'BTC';
  /** How much of the asset the user holds. */
  quantity: number;
  /** Total USD value the holding must be worth at the deadline. */
  floorTotalUsd: number;
  horizonDays: number;
};
```

### 3.2 `impliedStrike` (src/core.ts) — new pure function

```ts
/** The per-unit strike a total-value floor implies. This is what matches Candidate.strike. */
export function impliedStrike(spec: ProtectionSpec): number {
  return spec.floorTotalUsd / spec.quantity;
}
```

Exported, pure, unit-tested. `filterCandidates` sorts by `Math.abs(c.strike - impliedStrike(spec))` instead of the old `spec.floorUsd` comparison. This is the single source of truth for the per-unit number — nothing else computes it independently.

### 3.3 Validation (src/intent.ts)

- LLM prompt now asks for `quantity` and `floorTotalUsd` (four fields total including asset/horizonDays), explicitly instructed **not** to divide or multiply — report only what's stated, as transcription, not arithmetic. This tightens design rule 2 rather than loosening it: the model still never produces a number the user sees, and now it can't silently pick a per-unit-vs-total basis either.
- If `quantity` is absent or non-positive, `validateSpec` **throws** ("I need to know how much ETH you hold") rather than defaulting to 1. A silent default is exactly the class of quiet-wrong-number this codebase refuses elsewhere.
- New check: `impliedStrike(spec)` must itself be finite and within `[1, 10_000_000]` — this is what turns "1000 ETH, $798 total" into a clear rejection instead of a search for an $0.80 strike.

### 3.4 Downstream blast radius (breaking changes, called out explicitly)

- `src/cli.ts` — `quote`/`simulate`/`execute` share one arg-parsing path; args become `<quantity> <floorTotal> <collateral> [days]` instead of `<floor> <collateral> [days]`. This is a breaking CLI interface change; document it in the CLI's own usage string and in README.
- `src/server.ts` — `toWire()` should carry `impliedStrike` and distance-from-spot alongside the existing candidate fields so the UI never recomputes them.
- `web/index.html` — form fields (`asset`, `amount`, `floor`, `days`) map to `{asset, quantity, floorTotalUsd, horizonDays}`; `currentSpec()` now sends `quantity`; the restated sentence gains the derived per-unit clause (see §4.3).
- `README.md`, `docs/demo-runbook.md` — update any CLI invocation examples and the illustrative $2,300 example to state quantity explicitly.
- `tests/fixtures.ts`, `tests/filter.test.ts`, `tests/intent.test.ts` — update to the new spec shape; add `tests/implied-strike.test.ts` for the new pure function (basis cases, division-by-small-quantity edge, out-of-range rejection).

---

## 4. Unified chart

### 4.1 New module `src/spot.ts`

A price oracle is not a Thetanuts concern, so per design rule 1 it does not belong in `core.ts`. It imports the feed address from `core`'s already-exported `chainConfig.priceFeeds[asset]` (the same feed `findCandidates` matches candidates against at [src/core.ts:264](../../../src/core.ts#L264)) and talks to `ethers` directly for `latestRoundData()`.

Split for testability:
- `toCandles(rawRows): Candle[]` — pure, exported, unit-tested. Normalizes Coinbase's raw candle rows into `{t, o, h, l, c}`.
- `fetchHistory(asset, days)` — async, calls Coinbase Exchange's public candles endpoint.
- `fetchSpot(asset, client)` — async, calls `latestRoundData()` on the Chainlink feed, returns `{price, updatedAt, feed}`.

### 4.2 New route `GET /api/history?asset=ETH&days=N` (src/server.ts)

Cached ~60s per asset (in-memory, same pattern as the existing candidate cache). Response shape:

```json
{
  "candles": [{ "t": 0, "o": 0, "h": 0, "l": 0, "c": 0 }],
  "spot": { "price": 0, "updatedAt": "iso", "feed": "0x...", "source": "chainlink" },
  "historySource": "coinbase-exchange"
}
```

If the Coinbase fetch fails, the route still returns `spot` with `candles: []` — the chart degrades (see 4.4), it never blocks the flow, and the failure never gets silently treated as "no candles exist."

### 4.3 Geometry (web/index.html, hand-rolled SVG, no charting library — consistent with the existing `drawPayoff`)

- **Y axis: price.** Shared across the whole chart. Range spans candle high/low ∪ strike ∪ spot, with padding.
- **X axis: time.** From `now - historyDays` to the option's expiry. History occupies the left ~70% of the width, the future ~30%.
- **Candles** in the history region: wick = high→low, body = open→close, `--accent` for up candles, `--danger` for down.
- **Strike line**: horizontal at `impliedStrike(spec)`. Dashed across the past (didn't exist yet), solid across the future. Label: `$2,493.75 floor · your $798 ÷ 0.32 ETH`.
- **Spot line**: dotted, horizontal at current spot. Label: `$2,610 now · Chainlink`. Annotate the gap to strike as a percentage (`4.5% below spot`) — this is the variable the pricing table in PROJECT.md is built on and today is invisible.
- **Expiry marker**: vertical line at the option's expiry date, labeled with the date.
- **Protected zone**: shaded rectangle below the strike line, spanning from today to expiry — "if it settles in here, you're paid the difference."
- **Payoff gutter**: existing `payoffCurve` output, transposed so `spot` maps to the shared Y axis and `pnl` maps to a narrow X strip on the chart's right edge, with a zero baseline. No new math — reuses `core.ts`'s existing pure `payoffCurve`.
- **Attribution caption** (design rule 3 — four numbers, four sources, stated plainly): candles from Coinbase, spot and settlement price from Chainlink, strike from the live Thetanuts order, payoff from `previewFillOrder`.

### 4.4 Degradation

If `/api/history` fails or returns empty candles, the chart drops the candlestick layer and still renders strike, spot (if available), expiry, protected zone, and the payoff gutter. It never blocks step 3 → step 4 progression.

---

## 5. Other UX findings (scoped in, all three tiers)

Found while auditing `web/index.html` against the product's own stated claims, not generic heuristics. Ordered by how badly each undercuts the pitch.

**Also:** `HANDOFF.md`'s "Known residual issue #1" (duplicate-fill re-arm hazard in `runSimulate()`) is now **stale** — `runSimulate()` no longer touches `execBtn` ([web/index.html:915-948](../../../web/index.html#L915)); only `rearmExecute()`/`resetFlow()` clear the manual-clear gate. Delete that section of `HANDOFF.md` as part of this work so the next agent doesn't go "fix" a bug that no longer exists.

### Correctness tier (bugs, not preferences)

1. **Live API call on every keystroke, discarding the user's selection.** `onConstraintChange` → `renderCandidates` → `selectCandidate(0, …)` → `POST /api/quote` ([web/index.html:653](../../../web/index.html#L653), [748](../../../web/index.html#L748), [762](../../../web/index.html#L762)). Typing `2300` → `23004` fires a live `previewFillOrder` round-trip per keystroke and silently resets the user's candidate selection to index 0 each time. **Fix:** debounce the input handler (~400ms) and stop force-resetting to candidate 0 when candidates are merely re-rendered for the same spec.
2. **"closest match" badge is unconditional.** [web/index.html:734](../../../web/index.html#L734) badges index 0 green regardless of distance; `filterCandidates` has no distance ceiling — sorts by `|strike - impliedStrike|` and slices 8, never rejects far misses. **Fix:** add a distance threshold (e.g., candidate strike within some % of implied strike) below which the badge doesn't render, and add honest copy for "results exist but none are close" (parallel to the existing zero-results copy at [web/index.html:713](../../../web/index.html#L713)).
3. **NL parse never fills the amount field.** [web/index.html:672-676](../../../web/index.html#L672). Once quantity is load-bearing (§3), this becomes a correctness gap. **Fix:** `parseIntent` returns `quantity`; `parseNL()` writes it into the `amount` field like the other three fields.

### Honesty tier (places where the UI undersells a promise the code keeps)

4. **Coverage gap is a small amber pill only.** For a product whose differentiator is "a stop-loss protects the path, a put protects a date," an option expiring before the user's date is a category failure, not a footnote — and `payoffSummary` never mentions it. **Fix:** when `coverageGapDays > 0`, add an explicit sentence to `payoffSummary`, not just the step-2 candidate badge.
5. **Judgment verdict has no visual weight.** `not-worth-it` and `reasonable` render identically — dashed grey border, same text style ([web/index.html:764](../../../web/index.html#L764)). **Fix:** style verdict severity (color/icon) so the deterministic non-LLM judgment — one of the two strongest technical claims in the pitch — is visually legible at a glance.
6. **Coverage shortfall buried in a subordinate clause.** [web/index.html:809](../../../web/index.html#L809): *"This covers 0.0040 of your 1 ETH — the rest is unprotected."* When maker-budget capping causes a near-total miss of the stated goal, that belongs in the headline, not a trailing clause. **Fix:** promote a large capped-coverage shortfall to its own visible line/badge.
7. **Candidate list computes its own premium.** `pricePerContract * heldAmount` at [web/index.html:735](../../../web/index.html#L735) is presentation-layer arithmetic — forbidden by `HANDOFF.md`'s own rule ("presentation layers should never compute a number `core.ts` could compute instead") — and can disagree with the real `spendUsdc` the quote later returns. **Fix:** either have `/api/candidates` return a per-candidate estimated total (computed server-side, clearly labeled "estimate, confirmed at quote"), or drop the total from the list and show only `$/unit` until a quote is fetched.

### Polish tier (cheap, cut first if time is short)

8. **No retry on step-2 fetch failure.** `candLoading.textContent = 'Error: …'` ([web/index.html:719](../../../web/index.html#L719)) is a dead end. **Fix:** add a retry button.
9. **Candidates aren't keyboard-reachable.** Clickable `<div>`s with no `role`, no focus ring, no Enter/Space handling. **Fix:** make them real buttons or add `role="button"`, `tabindex`, focus styles, and key handling.
10. **`.mock-banner` class name is stale.** The banner now says "LIVE" but keeps its old class name from when data was mocked. **Fix:** rename the class (or add an alias) so future readers aren't misled by the name.

---

## 6. Testing approach (per repo convention — pure functions unit-tested, live behavior verified ad hoc)

- `impliedStrike` — new pure-function tests in `tests/implied-strike.test.ts`: normal case, small-quantity edge (large implied strike), zero/negative quantity rejected upstream by `validateSpec`, out-of-range implied strike rejected.
- `filterCandidates` — update `tests/filter.test.ts` fixtures to the new `ProtectionSpec` shape; add a case asserting ranking is by `impliedStrike`, not raw `floorTotalUsd`.
- `validateSpec` — update `tests/intent.test.ts`: missing/invalid `quantity` throws; the four-field LLM output shape; out-of-range implied strike throws with a clear message.
- `toCandles` — new pure-function tests in `tests/spot.test.ts` (or similar) covering normal Coinbase row shapes and malformed/empty input.
- Live/network behavior (the new `/api/history` route, real Coinbase fetch, real `latestRoundData()` call) verified ad hoc via CLI/browser per existing repo convention — never inside `vitest`.
- Run `npm test` and `npx tsc --noEmit` before considering any task done, per `HANDOFF.md`'s existing rule. `tsc` has one known pre-existing unrelated error (`chainConfig.contracts.optionBook: string | null`) — don't let a second one join it.

---

## 7. Explicitly out of scope

- No new external API keys or paid services — Coinbase Exchange's public candles endpoint and the existing Chainlink feed are both already-accessible without new credentials.
- No change to `execute()`'s core safety logic (assertFillable → simulate → allowance → fillOrder) — this design touches only matching/labeling/charting.
- No testnet support (design rule 7 — Base mainnet only).
- No persistence/database for price history — in-memory cache only, matching the existing candidate cache pattern.
