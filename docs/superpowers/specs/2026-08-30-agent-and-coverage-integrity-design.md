# Payung — AI Agent & Coverage Integrity

**Date:** 2026-08-30
**Status:** Approved for planning
**Scope:** Track 02 (AI × Options) agent depth, plus four verified UX-integrity defects

---

## 1. Problem statement

Payung today is a strong product with a thin agent. The LLM performs exactly one
job — transcribing a sentence into four fields (`src/intent.ts`) — and every
other decision is a fixed pipeline. Applying the hackathon's own criterion in
the mirror: *if the LLM were replaced by a four-field form, the product would
work identically.* The options are load-bearing; the AI is not.

Separately, four product defects were found by review. Three are confirmed in
code and one exposes an undocumented protocol behaviour. They matter because the
judging rubric weights "would anyone actually use it" equally with "does it work".

This design addresses both in one pass, because they share a root: **the system
knows more than it tells the user**, and the fix in both cases is to surface
grounded, computed truth rather than a convenient summary.

---

## 2. Invariants

These hold before and after this work. Every design decision below defers to them.

1. **The model never originates a number the user sees.** Today this is true by
   construction (the LLM only emits four transcribed fields). Adding a chat
   agent breaks it by default, because chat prose contains numbers. Section 6
   restores it by enforcement rather than by construction.
2. **The user can never accidentally write (sell) an option.** The
   `takerIsBuyer` and `!isCall` filters in `filterCandidates` are the guarantee.
   No new surface — agent, MCP, or watcher — may bypass `filterCandidates`.
3. **Nothing spends funds without either a human signature or an explicit,
   bounded, pre-declared policy.**
4. **Server-side signing stays disabled on Vercel.** `serverSigningAllowed()`
   in `src/api-shared.ts` is unchanged by this work.
5. **If nothing on the book fits, the system says so.** It never substitutes a
   near-miss silently. This design extends that rule from *strike* to *expiry*.

---

## 3. Phase 0 — Banked trade and the settlement spike

### 3.1 Banked trade

Track 02's bar is a real fill against live pricing. It is currently unmet:
`PROJECT.md` records a `$10 simulated fill`, and `README.md` still holds a
placeholder where the BaseScan URL belongs. Nothing else in this document
matters until this is done.

Execute per `docs/demo-runbook.md`, then record in `README.md`: the BaseScan
URL, the exact paid figure read from the fill receipt's Transfer logs, and a
screen recording of the full flow.

**Additional requirement — bank two positions, not one:**

- **Position A (proof):** the headline trade. Any fillable put. Its hash is the
  submission artifact.
- **Position B (watcher subject):** deliberately **short-dated**, chosen so that
  its `daysToExpiry` will fall inside the watcher's roll trigger during the demo
  window. Without a position that is genuinely near expiry, Phase 3 has nothing
  to act on and the autonomy claim cannot be shown live.

Position B should be sized at the minimum fillable amount. Both must be recorded
in the commitment store (Section 7.1) at execution time, or the watcher cannot
associate them with a stated deadline.

### 3.2 Settlement spike

**Question:** after expiry, does a cash-settled OptionBook put pay the buyer
automatically, or must someone call something?

**Evidence that this is a real gap, not an oversight:** the SDK defines

```
type OptionStatusType = 'active' | 'closed' | 'expired-awaiting-settlement'
                      | 'settled-itm' | 'settled-otm'
```

The existence of a distinct `expired-awaiting-settlement` state proves payout is
not simultaneous with expiry. `PositionSettlement` further carries
`payoutBuyer`, `exercised`, and `explicitDecision: boolean` ("whether settlement
was an explicit decision") — implying both an automatic and an explicit path
exist. The `exercise()` / `doNotExercise()` methods found in the SDK belong to
the **loan** module (physically-settled call loans) and are unlikely to govern
cash-settled book puts.

**Method — empirical, no mentor required as a blocker:** the indexer that
`app/api/positions/route.ts` already queries holds thousands of records. Query
settled book-put positions and tabulate:

- the distribution of `explicitDecision` across `settled-itm` positions,
- the sender of the settling transaction for a sample of them,
- the wall-clock delay between `expiry` and settlement.

If settled positions are predominantly `explicitDecision: false` and the settling
sender is a consistent non-participant address, settlement is keeper-automatic
and Payung can state so with measured evidence. If they are predominantly
`true`, the buyer must act, and Phase 4 must add a claim path.

Ask the Thetanuts mentor **in parallel**, as confirmation. Do not block on the
answer; the measurement is available today.

**Output:** a short findings note committed to `docs/`, and the copy decision
that feeds Section 8.2. If the result is genuinely ambiguous, the UI states the
ambiguity plainly rather than guessing.

---

## 4. Phase 1 — Coverage-first ranking

### 4.1 Defect

The user's request is two-dimensional — a floor **and** a deadline — but both
ranking and labelling collapse it to one dimension.

- `filterCandidates` (`src/core.ts:197`) sorts by
  `Math.abs(a.strike - target) - Math.abs(b.strike - target)`. **Expiry never
  enters the ordering.**
- The eligibility window (`src/core.ts:194`) admits
  `horizonDays * 0.6 … * 2.5`. For a 14-day request, an **8.4-day** option is
  eligible and may rank first.
- `public/app.js:540` sets `EXACT MATCH` when
  `selectedIndex === 0 && heroDist < 0.01`, where `heroDist` is
  `pctFromImpliedStrike`. The badge is truthful about the *strike* and reads to a
  user as "exactly what you asked for" — on an option that expires days early.
- The coverage gap is disclosed only at Step 3, after the user has anchored.

This violates invariant 5 along the expiry axis.

### 4.2 Design

**Partition before sorting.** Replace the single sort with a two-partition rank:

```ts
// src/core.ts
export function rankCandidates(
  eligible: Candidate[],
  spec: ProtectionSpec
): Candidate[]
```

1. Partition eligible candidates into `covering` (`daysToExpiry >= spec.horizonDays`)
   and `short` (`daysToExpiry < spec.horizonDays`).
2. Sort **within** each partition by absolute strike distance from
   `impliedStrike(spec)` — the existing comparator, unchanged.
3. Concatenate `covering` first, then `short`.
4. Truncate to 8, **reserving one slot for the cheapest `short` candidate**
   whenever both partitions are non-empty. Without this reservation a
   fully-covering book hides the cheaper partial option the user is entitled to
   compare against.

`filterCandidates` keeps its filters and delegates ordering to `rankCandidates`.
The eligibility window is unchanged: short options remain *offerable*, they
merely stop being *ranked first and mislabelled*.

**Name the trade explicitly.** Ranking full coverage first surfaces a more
expensive option by default. Presenting that silently is an upsell. A new pure
function computes the comparison:

```ts
export type CoverageChoice = {
  best: Candidate | null;           // best fully-covering candidate
  cheaperShort: Candidate | null;   // cheapest short-dated alternative
  premiumDelta: number | null;      // best − cheaperShort, per contract
  gapDays: number | null;           // days cheaperShort falls short
  surplusDays: number | null;       // days best exceeds the deadline
};
export function coverageChoice(ranked: Candidate[], spec: ProtectionSpec): CoverageChoice;
```

The UI renders this as a single sentence naming both numbers — e.g. *"$2.55 more
buys the 4 days you asked for"* — so the cost of full coverage is a stated
trade, never an assumption.

**Move the badge into testable code.** Badge logic currently lives inline in
`public/app.js` and cannot be tested. Extract to a pure module shared by the web
UI and the CLI:

```ts
// src/presentation.ts
export type CoverageState = 'full' | 'surplus' | 'short' | 'far-from-floor';
export type Badge = { state: CoverageState; text: string; tone: 'good' | 'warn' | 'neutral' };
export function badgeFor(c: Candidate, spec: ProtectionSpec, isTopPick: boolean): Badge;
```

The badge must state both dimensions. `EXACT MATCH` is retired; it cannot be
made truthful, because it names one axis while implying two.

| Condition | Text | Tone |
|---|---|---|
| Covers horizon, strike within 0.01% | `FULL COVER · EXACT FLOOR` | good |
| Covers horizon, strike near | `FULL COVER · −1.2% FLOOR` | good |
| Short of horizon | `2.1 DAYS SHORT · EXACT FLOOR` | warn |
| Strike beyond `CLOSEST_MATCH_MAX_PCT` | `FAR FROM YOUR FLOOR · −8.4%` | warn |

Coverage tone is decided before strike proximity: a floor that evaporates early
is a worse defect than a floor a fraction of a percent off.

**Disclose at Step 2.** The coverage state appears on the candidate card itself,
carrying the tone above. The existing Step 3 `COVERAGE GAP` block stays — a
second, fuller statement before money moves is correct, not redundant.

### 4.3 Tests

Pure, network-free, in the existing vitest setup:

- covering candidate ranks above a short one with a nearer strike
- ordering within each partition still follows strike distance
- cheapest short candidate survives truncation when 8+ covering exist
- `coverageChoice` returns nulls when a partition is empty
- `badgeFor` never emits a `good` tone for a short candidate
- `premiumDelta` sign convention holds when the covering option is *cheaper*

---

## 5. Phase 2a — The tool registry

### 5.1 Rationale

One transport-agnostic registry serves three consumers: the agent loop
(OpenAI-style function calling), the MCP server (Phase 6), and the watcher.
Defining tools once is what reduces the MCP server to a thin adapter and keeps
the safety filters from drifting between surfaces.

Native tool calling is **confirmed working** on Gonka Router with
`deepseek-ai/DeepSeek-V4-Flash-0731`: a probe returned
`finish_reason: "tool_calls"` with a well-formed `tool_calls` array. No ReAct
fallback is required.

### 5.2 Shape

```ts
// src/tools.ts
export type ToolResult =
  | { ok: true; data: unknown; numbers: number[] }
  | { ok: false; error: string };

export type ToolDef = {
  name: string;
  description: string;
  parameters: object;        // JSON Schema — consumed by both OpenAI and MCP
  readOnly: boolean;         // gates write access per surface; MCP annotation
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
};

export const TOOLS: ToolDef[] = [ /* … */ ];
```

**`numbers` is load-bearing.** Every tool declares the flat set of numeric values
it returned. This is the allowlist the grounding guard (Section 6) checks
against. Deriving the allowlist from a declared array rather than by walking
arbitrary JSON keeps the guard exact instead of heuristic, and makes it obvious
in review when a tool leaks an undeclared number.

### 5.3 Tools

| Name | Read-only | Wraps | Notes |
|---|---|---|---|
| `get_spot` | ✓ | `fetchSpot` | live Chainlink read |
| `find_protection` | ✓ | `findCandidates` + `rankCandidates` + `coverageChoice` | returns ranked candidates **and** the coverage trade-off |
| `quote_candidate` | ✓ | `quote` | live `previewFillOrder` |
| `judge_candidate` | ✓ | `judgeQuote` | deterministic verdict + reasons |
| `payoff_at` | ✓ | `payoffCurve` | points for stated spot prices |
| `list_positions` | ✓ | positions indexer | reuses `app/api/positions` shaping |
| `simulate_fill` | ✗ | `simulate` | free `callStaticFillOrder`, needs a signer address |
| `propose_execution` | ✗ | `prepare-tx` | **terminal**: returns an unsigned tx for a human. Never signs. |

**The agent is never given an `execute` tool on the web surface.** Its terminal
action is `propose_execution`; the human signs with their own wallet. In the CLI
an `--execute` flag may add a policy-gated execute tool, subject to invariant 3.

`find_protection` must return **near-misses with reasons** when nothing matches,
so the agent has real alternatives to offer rather than improvising. This is what
makes multi-turn negotiation fall out of the loop for free: the agent can say
"nothing covers 14 days; the nearest is 11.9 days at $17.45, or I can look at a
lower floor" because the tool handed it those options.

---

## 6. Phase 2b — The agent loop and the grounding guard

### 6.1 Why the guard is not optional

Payung's headline claim is that the LLM never generates a number the user sees.
A chat agent writes prose containing numbers, so the claim becomes false the
moment the loop ships — **unless it is enforced**. The guard is therefore part of
Phase 2, not a later enhancement. It also converts an asserted property into a
demonstrable one, which is strictly stronger in front of a judge.

### 6.2 Loop

```ts
// src/agent.ts
export type AgentTurn = {
  messages: ChatMessage[];
  allowedNumbers: number[];       // accumulated from every ToolResult.numbers
  candidates: Map<string, Candidate>;
};
export async function runAgentTurn(
  turn: AgentTurn, userText: string, llm: LlmClient
): Promise<AgentTurn>;
```

- Bounded at 8 tool-call rounds per turn; exceeding the bound ends the turn with
  a deterministic "I could not resolve that" message rather than looping.
- The system prompt forbids arithmetic and requires a tool call for every number,
  mirroring the existing rule in `src/intent.ts`.
- The user's own stated figures (quantity, floor, horizon) join `allowedNumbers`,
  since echoing them back is legitimate.
- Every assistant message with user-facing content passes the guard before
  surfacing. No exceptions.

### 6.3 Guard

```ts
// src/grounding.ts
export type NumberToken = { raw: string; value: number; index: number };
export function extractNumbers(text: string): NumberToken[];
export function isGrounded(tok: NumberToken, allowed: number[]): boolean;
export function checkGrounding(text: string, allowed: number[]):
  { ok: boolean; ungrounded: NumberToken[] };
```

**Rule.** A token is grounded if some allowed value, rounded to the number of
decimal places the model actually wrote, equals the token's value. This admits
legitimate rounding (`12.081192` → `"$12.08"`) while rejecting invention.

**Parsing.** Strip `$`, `,`, and `%` before parsing; handle thousands separators
and multipliers (`2.1x`). Only **digits** are checked — prose like "two weeks" is
unconstrained, which is correct: the risk is fabricated precision, not language.

**On violation.** One regeneration attempt with a corrective message naming the
offending tokens. If the second attempt also fails, discard the model's prose and
render a deterministic fallback built from the last tool result. Ungrounded text
is never surfaced. Every violation appends to the audit log — a guard that
visibly fires is a better demo than one that never does.

### 6.4 Surfaces

- **Web:** a chat pane alongside the existing pipeline. The fixed pipeline is
  untouched and remains the reliable banked-demo path.
- **CLI:** `npm run agent`.

### 6.5 Tests

Pure and network-free. `extractNumbers` across currency, percent, thousands
separators, and decimals. `isGrounded` rounding-tolerance boundaries. Adversarial
cases: a plausible-but-absent premium; a correct number at false precision; a
number appearing only in an *earlier* tool result (must pass, since the allowlist
accumulates across the turn).

---

## 7. Phase 3 — The re-hedge watcher

### 7.1 Commitment store

The chain records the option. It does not record **the deadline the user stated**
— and that deadline is exactly what makes an expiring position a problem. A local
store closes the gap:

```ts
// src/commitments.ts   →  .payung/commitments.json
export type Commitment = {
  txHash: string;
  optionAddress: string;
  spec: ProtectionSpec;         // asset, quantity, floorTotalUsd, horizonDays
  deadlineIso: string;          // horizonDays resolved to an absolute date at execution
  strike: number;
  expiryIso: string;
  contracts: number;
  rollsUsed: number;
  createdAt: string;
};
```

Written on every successful execution, in both the CLI and `/api/prepare-tx`
confirmation paths. `horizonDays` is resolved to an absolute date at write time;
a relative horizon is meaningless to a process that wakes up days later.

### 7.2 Decision function

One pure function decides; two thin modes act. This is what lets the safe default
and the autonomous mode share a single tested decision path.

```ts
// src/policy.ts
export type RollPolicy = {
  rollWhenDaysToExpiry: number;   // trigger threshold
  minDeadlineDaysLeft: number;    // don't roll if the deadline has effectively passed
  maxPremiumUsd: number;          // per roll
  maxRolls: number;               // per commitment
  assets: ('ETH' | 'BTC')[];
};

export type RollDecision =
  | { action: 'none';    reason: string }
  | { action: 'roll';    reason: string; remainingDays: number; deadlineDaysLeft: number }
  | { action: 'blocked'; reason: string };

/**
 * ShapedPosition is the already-normalised position shape produced by
 * `shapeProtection` in app/api/positions/route.ts. Extract that shaping into
 * `src/positions.ts` so the route, the watcher, and the `list_positions` tool
 * share one definition instead of three — decideRoll must stay pure and must
 * not import the route.
 */
export function decideRoll(
  position: ShapedPosition, commitment: Commitment, now: Date, policy: RollPolicy
): RollDecision;
```

**Trigger — expiry-approaching only.** Per the scoping decision, spot-relative
and cheaper-order triggers are out of scope. Roll when *all* hold:

1. `position.status === 'active'`
2. `daysToExpiry(position) <= policy.rollWhenDaysToExpiry`
3. `deadlineDaysLeft(commitment, now) > policy.minDeadlineDaysLeft`
4. `commitment.spec.asset ∈ policy.assets`

`blocked` is returned — never `none` — when a trigger fires but a limit stops it
(`rollsUsed >= maxRolls`, or replacement premium `> maxPremiumUsd`). The
distinction matters: `none` means "nothing to do", `blocked` means "action needed
but policy forbade it", and only the latter must reach the user.

### 7.3 Modes

Both run locally against the burner wallet. Neither runs on Vercel;
`serverSigningAllowed()` is untouched. Only `--auto` signs — the default mode
prepares and alerts, and the human signs.

- **`npm run watch` (default, MVP).** Detects, finds and quotes a replacement via
  the same tools, writes a pending action, and alerts:

  > 🔔 Your Payung protection expires tomorrow.
  > A replacement extends your floor to Sep 16 for $18.20.
  > `[Review & Extend]`

  The human confirms and signs. Nothing is spent autonomously.

- **`npm run watch -- --auto` (opt-in).** Identical decision path; on `roll` it
  simulates, then executes within `maxPremiumUsd` and `maxRolls`, increments
  `rollsUsed`, and logs. Demonstrated live with deliberately small limits.

`--auto` must refuse to start unless every policy field is explicitly set — no
defaults for a mode that spends money unattended.

### 7.4 Audit log

Append-only JSONL at `.payung/agent-log.jsonl`: timestamp, position, trigger,
`RollDecision`, policy snapshot, simulation result, tx hash. This is both the
operational record and the demo artifact — it is what proves autonomy occurred
rather than being described.

### 7.5 Tests

`decideRoll` is pure and is the bulk of the suite: trigger fires exactly at the
threshold; no roll when the deadline has passed; `blocked` (not `none`) at
`maxRolls`; `blocked` when the replacement premium exceeds the cap; asset not in
the allowlist. Policy validation rejects a partially-specified `--auto` policy.

---

## 8. Phase 4 — Progressive disclosure and settlement copy

### 8.1 Jargon

Confirmed: `makerBudget` renders on the primary hero card as
`maximum fill $10,000` (`public/app.js:553`), and aBasUSDC / Chainlink surface in
the flow markup — precisely at the payment step, where a retail user is most
likely to abandon.

Nothing is removed; everything moves behind disclosure.

**Main view:** premium, protection floor, expiry, coverage state (Phase 1),
settlement in plain words ("paid out in USDC").

**`▸ On-chain details`:** settlement asset (aBasUSDC), price source (Chainlink),
maker collateral / maximum fill, network (Base), OptionBook address, order
staleness.

The disclosure is a plain `<details>` element — keyboard accessible, open by
default for nothing, and never hiding a number the user is about to be charged.

### 8.2 Settlement

Driven by the Phase 0 spike. The flow is stated explicitly as
**Expiry → Settlement → Payout**, and the UI answers the user's actual question:
whether money arrives on its own, and roughly when.

- If measured keeper-automatic: state that the payout arrives without action, and
  name the observed typical delay.
- If buyer action is required: add a claim path and surface pending claims on the
  positions view — an unclaimed payout is a strictly worse failure than a
  mislabelled badge.
- If ambiguous: say so plainly and link the position on BaseScan.

---

## 9. Phase 5 — Evaluation suite *(stretch)*

`tests/eval/cases.jsonl` — natural-language input paired with the expected
`ProtectionSpec` or `PartialSpecResult`.

- **Offline mode (CI):** fixture LLM responses through the existing `LlmClient`
  seam. Deterministic, no network, no key. Guards `validateSpec` and
  `classifyPartialSpec` against regression.
- **Live mode (`npm run eval:live`):** hits Gonka and reports a pass rate.

Coverage: per-unit vs total floor ambiguity; missing fields; implausible
quantities; non-requests; unsupported assets; **Bahasa Malaysia inputs** —
appropriate to the product's name and its likely first users, and a genuine
robustness test rather than a demo flourish. Grounding-guard adversarial cases
live here too.

---

## 10. Phase 6 — MCP adapter *(stretch)*

`mcp/server.ts` exposes `TOOLS` over stdio, mapping `ToolDef` directly onto MCP
tool registration and using `readOnly` as the annotation. Because the registry
already carries JSON Schema, this is an adapter, not a reimplementation.

**Deliberately not** built on `@thetanuts-finance/mcp`. That server exposes a
generic surface that permits *writing* options, which would bypass invariant 2 —
the single thing a Payung user must never do by accident. Payung exposes its own
narrower, safety-constrained tool surface instead. This is a defensible answer to
"why not use the sponsor's MCP server?", and stronger than having used it.

---

## 11. Testing strategy

Every new decision is a pure function, tested without network, in the existing
vitest setup: `rankCandidates`, `coverageChoice`, `badgeFor`, `extractNumbers`,
`isGrounded`, `checkGrounding`, `decideRoll`, policy validation, commitment
serialisation.

Network-touching code stays thin and delegates: tools wrap `core.ts`, the agent
loop wraps the registry, the watcher wraps `decideRoll`. This preserves the
existing rule that intent tests pull no SDK or dotenv (`HANDOFF.md` rule 1) —
`src/tools.ts` must not be imported by any pure test.

Live verification is manual and recorded in the runbook: one banked trade, one
watcher roll observed end to end.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| No fillable put on the book at demo time | Banked trade is the submission; runbook already treats the live attempt as theatre |
| Agent loop latency or stalling on stage | Fixed pipeline untouched and remains the demo path; loop bounded at 8 rounds |
| Guard false-positives suppress good output | One regeneration, then deterministic fallback; violations logged, never silently dropped |
| Watcher rolls into a worse option | Policy caps + mandatory `simulate` before any execute; `--auto` refuses partial policies |
| Commitment file lost or absent | Watcher skips positions it has no commitment for and says so; never infers a deadline |
| Settlement spike returns ambiguous | UI states the ambiguity rather than asserting a behaviour |
| Scope overrun | Phases 5 and 6 are cuttable without touching Phases 0–4 |

---

## 13. Out of scope

Spot-relative and cheaper-order roll triggers; RFQ for exact strikes; server-side
autonomy on Vercel; price prediction or directional views of any kind; replacing
the existing pipeline with the agent; multi-asset portfolios beyond ETH and BTC.
