# HANDOFF.md — for the next AI agent working on this codebase

This file is written for an AI agent (or human) picking up this project cold. It covers what the project is, how the code is structured, what's safe to change, what's load-bearing, and — critically — the exact state this branch was left in, including one unresolved safety finding.

---

## What this project is

**Payung** ("umbrella" in Malay) is an options-protection product built on the Thetanuts SDK, running live on **Base mainnet** (chainId 8453). A user states a plain-language constraint — "I need my ETH worth at least $2,300 in two weeks" — and the system:

1. Parses that sentence into `{asset, floorUsd, horizonDays}` via an LLM (Gonka Router) — **the LLM's only job, ever**.
2. Queries the live Thetanuts orderbook, filters to currently-fillable put options that actually match (correct underlying, correct side, dollar-denominated collateral, roughly the right window).
3. Prices the best match using the protocol's own math (never invented numbers).
4. Shows a payoff curve and a deterministic (non-LLM) judgment: is this premium worth it?
5. Simulates the exact transaction for free (`callStaticFillOrder`).
6. Only on explicit user confirmation, executes for real and returns a BaseScan-verifiable transaction hash.

Built for **MUBA Hacks 2026**, targeting both Thetanuts tracks (SDK Product, AI × Options). Full pitch/context: [PROJECT.md](PROJECT.md). Detailed behavioral spec: [Payung_Spec.md](Payung_Spec.md). Original security/product audit that this branch's work responds to: [FableAudit.md](FableAudit.md).

**The one sentence that governs every design decision in this codebase:** *the LLM never produces a number the user sees.* Every price, premium, and payoff figure traces to a live SDK call or an empirical read of a transaction receipt — never a guess, never an estimate, never client-side math reconstructing what the server already computed correctly.

---

## Code structure

```
src/
  core.ts       — THE ONLY MODULE THAT TOUCHES THETANUTS. Everything else is a thin face over this.
  aave.ts       — USDC → aBasUSDC deposit helper (buyable puts settle in aBasUSDC, not raw USDC)
  intent.ts     — NL → ProtectionSpec via Gonka Router. Strictly validates the LLM's 3-field output.
  judgment.ts   — Deterministic (NOT LLM) premium-vs-value verdict + coverage-gap honesty
  server.ts     — Thin node:http JSON API over core.ts, plus static serving of web/
  cli.ts        — Terminal interface: book, whoami, quote, simulate, execute, preflight, deposit, ask
web/
  index.html    — The product UI. Vanilla JS, no framework, no build step. Talks to server.ts's API.
tests/
  fixtures.ts          — makeCandidate() factory + fake token/feed addresses (tests never touch network)
  decode.test.ts        — pure order-decoding
  filter.test.ts        — the safety-critical candidate filter (asset, side, collateral, window)
  fill-safety.test.ts   — budget capping, staleness guard, receipt-derived paid amount
  coverage.test.ts      — coverage-gap math
  aave-plan.test.ts     — Aave deposit decision logic
  intent.test.ts        — NL parsing + validation (fake LLM client, no network)
  judgment.test.ts      — premium-vs-value verdict logic
  wire.test.ts          — HTTP wire-format helpers (candidateId, toWire, jsonSafe)
docs/
  demo-runbook.md               — pre-demo checklist + pitch order for the hackathon
  superpowers/plans/...          — the implementation plan this branch executed (11 tasks, historical record)
PROJECT.md        — pitch, Q&A, track fit, pricing table, status checklist
Payung_Spec.md    — the detailed behavioral spec (functional requirements, edge cases)
FableAudit.md     — the original security/product audit this branch's work fixes
README.md         — setup instructions, "Run it," proof-of-real-trade section (currently a placeholder)
```

### `src/core.ts` — the one module that matters most

Read this file first, always. It owns every Thetanuts SDK call. Key exports, in the order data flows:

- `readClient()` / `writeClient()` — read-only vs. signing SDK clients. `writeClient()` throws without `PRIVATE_KEY`.
- `signerFromEnv(provider)` — extracted so `aave.ts` can sign without a second env-parsing path.
- `Candidate` (type) — a single decoded live order: side, strike, expiry, price, `priceFeed` (which underlying), `makerBudget` (in the order's own collateral-token units), greeks.
- `decodeOrder(o, scale, nowSec, collateralDec)` — **pure**, exported for tests. Decodes one raw SDK order.
- `getBook(client?)` — fetches + decodes every live order. **Never call this directly for a user-facing decision — always go through `findCandidates`.**
- `ProtectionSpec` (type) — `{asset: 'ETH'|'BTC', floorUsd, horizonDays}`, the parsed user intent.
- `FilterConfig` (type) + `filterCandidates(book, spec, cfg)` — **the safety-critical filter, pure and fully unit-tested.** Filters to: puts only, maker-is-seller only (so you're buying protection, never accidentally writing options), correct underlying asset (`priceFeed` match), dollar-denominated collateral only, roughly the right expiry window (0.6x–2.5x horizon), ranked by strike distance, capped at 8 candidates.
- `tokenSymbol` / `dollarTokens` — live-discovers which collateral tokens are dollar-denominated (checks a small hardcoded allowlist of known-good addresses first, falls back to a `symbol().endsWith('USDC')` heuristic for tokens not yet in the allowlist — see "Known residual issues" below).
- `findCandidates(spec, client?)` — the actual entry point everything else calls. Thin wrapper: `getBook` → `filterCandidates`.
- `capSpend(requestedUsdc, makerBudget)` — caps a fill to what the maker can actually absorb, never silently.
- `assertFillable(c, nowSec, bufferSec?)` — refuses to send against an order expiring within the buffer.
- `sumDebits(logs, token, from)` — reads what actually left the wallet from a transaction receipt's Transfer logs. This is how "max loss" is reported — **empirically, never asserted**.
- `Quote` (type) + `quote(candidate, requestedUsdc, client?)` — prices a fill via `previewFillOrder`, applying `capSpend`.
- `simulate(candidate, collateralUsdc, client?)` — **free** dry run via `callStaticFillOrder`. **Note: defaults to `writeClient()`, so it needs `PRIVATE_KEY` even though it's free** — a `callStatic` call needs a signer address to run against. This is SDK-driven, not a bug, but it means "free simulation" still requires wallet setup. Documented in README.
- `execute(candidate, spendUsdc, client?)` — the real fill. Order: `assertFillable` → `simulate` → `ensureAllowance` (exact amount, never MaxUint256) → `fillOrder`. **Never throws after `fillOrder()` has returned successfully** — if the paid amount can't be determined from receipt logs, returns `paidUsd: null` rather than fabricating $0 or throwing (a thrown error after a successful on-chain fill is how you get a UI that invites a duplicate real-money click — see the parked finding below).
- `payoffCurve(q, spotRange, points)` — pure math for the UI's chart. No network, no LLM.

### `src/aave.ts` — collateral bridging

Buyable puts settle in `aBasUSDC` (Aave-wrapped USDC), not raw USDC. `planDeposit(...)` is a pure decision function (none / deposit-the-shortfall / blocked); `ensureDollarCollateral(...)` executes it — exact-amount approval, `staticCall` dry run, then the real Aave `supply`.

### `src/intent.ts` — the entire AI surface

`gonkaLlm()` is the transport (OpenAI-compatible chat completions). `parseIntent(text, llm)` calls it, extracts the first *balanced* JSON object from the response (a hand-rolled brace-depth scanner respecting string literals — not a naive regex, because LLMs sometimes echo format examples or nest their answer), and `validateSpec(obj)` strictly validates the three fields (`asset` must be exactly `'ETH'`/`'BTC'`, `floorUsd` in `[1, 10_000_000]`, `horizonDays` in `[1, 90]`). Anything else — off-topic input, out-of-range values, malformed shape — throws a clear, honest error. **This module can never produce a number that reaches the user**; it only ever produces a filter over live data.

### `src/judgment.ts` — the agent's visible "judgment," deliberately not an LLM call

`judgeQuote(quote, coverageGapDays)` computes premium-as-percent-of-floor and buckets it: ≤5% reasonable, 5–10% expensive, >10% not-worth-it (thresholds from `PROJECT.md`'s own pricing guidance). Also folds in a coverage-gap warning if the option's protection ends before the user's stated deadline. **Deliberately deterministic** — judgment over real numbers should be auditable, not a model guess.

### `src/server.ts` — the HTTP API

Plain `node:http`, no framework (five routes don't justify one). Binds to `127.0.0.1` only (not all interfaces — this is a local single-user demo app with a real-money endpoint). Routes:

- `POST /api/parse` `{text}` → `{spec}` — wraps `parseIntent`
- `POST /api/candidates` `{spec}` → `{candidates: [...]}` — wraps `findCandidates`, populates an in-memory cache keyed by a stable id (candidates carry BigInts + raw SDK objects that must never cross the wire)
- `POST /api/quote` `{id, spendUsdc}` → `{quote, judgment, payoff}`
- `POST /api/simulate` `{id, spendUsdc}` → `{ok, error?}`
- `POST /api/execute` `{id, spendUsdc, confirm}` → `{hash, explorer, paidUsd}` — **requires `confirm: true` or 400s**; this is the one deliberate human-confirmation gate before real money moves
- `GET /*` → static files from `web/`

Client-input errors (bad spec, unknown candidate id) are tagged with a `ClientError` marker class and surface as 400; genuine server/SDK errors surface as 500.

### `web/index.html` — the product UI

Single file, vanilla JS, no build step, no framework. A 4-step flow (state constraint → live candidates → payoff + judgment → simulate/execute). Fully wired to the real API — no mock data remains anywhere in this file. Talks to every route in `server.ts` above.

### `src/cli.ts` — terminal interface

`book` (read-only book dump), `whoami` (wallet + balances), `quote`/`simulate`/`execute` (share one code path, args: `floor collateral [horizonDays=14]`), `preflight` (pre-demo freshness/fillability check), `deposit` (Aave top-up), `ask` (NL entry point). Run via `npm run <name> -- <args>`.

---

## How to run it

```bash
npm install
cp .env.example .env   # fill in PRIVATE_KEY (burner wallet), BASE_RPC_URL, GONKA_API_KEY
npm test                # 40 pure-function tests, zero network calls
npm run book             # live read against Base mainnet, no wallet needed
npm run web               # http://localhost:8787 — the full product
```

**Wallet requirement, precisely:** browsing, asking (NL parsing), viewing candidates, and getting a quote + payoff chart need **no** wallet. Simulating and executing both need `PRIVATE_KEY` in `.env` — even "free" simulation calls `callStaticFillOrder`, which needs a signer address.

---

## Testing philosophy — read this before adding code

- Every pure function (filtering, decoding, capping, judgment, intent validation, deposit planning) is unit tested in `tests/` with **zero network access**. `tests/fixtures.ts` provides fake-but-valid-shaped addresses for this.
- Live-network behavior is verified separately, ad hoc, via the CLI (`npm run book`, `npm run quote -- ...`) — never inside `vitest`.
- If you add a new piece of decision logic (a new filter, a new cap, a new validation rule), extract it as a pure function first and test it before wiring it into `core.ts`'s async wrappers or the CLI/server.
- Run `npm test` (must stay green) and `npx tsc --noEmit` before considering any change done. `tsc` currently reports exactly **one** pre-existing, out-of-scope error (`src/core.ts`, `chainConfig.contracts.optionBook: string | null`) — it predates all work described below and is intentionally left alone; don't be alarmed by it, but don't let a second one join it either.

---

## Known residual issues (read before touching related code)

### 1. UNRESOLVED — a real safety gap in the web UI's execute/simulate interaction

**This is the single most important thing to know about this codebase's current state.** A recent hardening pass closed an obvious bug where a failed `execute()` call would silently re-arm the "Execute for real" button (inviting a user to click again and potentially send a duplicate real-money transaction after a fill that may have already landed on-chain). The fix added a manual "I've checked, let me retry" gate in `web/index.html`'s `runExecute()`.

**But a second door was found and left open:** `web/index.html`'s `runSimulate()` function independently and unconditionally writes `execBtn.disabled = !sim.ok` on every simulate click — completely bypassing the new manual-clear gate. So after a failed execute, a user can just click "Simulate fill" again; if the simulation still succeeds (plausible if the order has remaining liquidity), the Execute button silently re-arms with **no confirmation step at all**, recreating the exact hazard the fix was supposed to close.

**Fix needed (not yet done):** make `rearmExecute()` the sole path back to an armed `execBtn` state. `runSimulate()` should check a "needs manual clear" flag before touching `execBtn.disabled` — if that flag is set (a prior execute failed post-fill), a fresh simulate success should NOT re-enable Execute; only the explicit "I've checked" click should.

**Do this before ever running a real, funded demo of this product.** The dollar exposure is small (~$10 per fill, per the hackathon's own "a $1 fill scores the same as $100" guidance), but a duplicate on-chain mainnet transaction on stage is an avoidable, embarrassing mistake.

### 2. First real on-chain fill has not been executed

No `.env`/`PRIVATE_KEY` has existed in any environment this code has run in so far. `README.md`'s "Proof" section is an honest, explicit placeholder (bracketed instructions, not a fake-looking hash or invented dollar figure) — **never replace a placeholder like this with an invented value; only a real transaction's real hash belongs there.** Before hackathon submission, a human needs to: fund a burner wallet with ~$20 USDC + gas on Base, follow `docs/demo-runbook.md`'s "Days before" checklist, and paste the real BaseScan URL + paid amount into `README.md`.

### 3. Minor, deferred, non-blocking

- `dollarTokens()`'s address allowlist is small (USDC + aBasUSDC on Base mainnet) and falls back to a `symbol().endsWith('USDC')` heuristic for anything not in it — a reasonable defense-in-depth tradeoff, not a full solution, if the live book ever quotes a new dollar-denominated collateral token.
- `/api/parse` doesn't use the `ClientError` 400-tagging pattern that `/api/candidates` does — LLM refusals surface as 500 instead of 400. Cosmetic; the UI displays the error message either way.
- The CLI and web UI both hardcode the same illustrative example numbers ($2300, 14 days) in a couple of places (docs, defaults) — no single source of truth if the team's target demo numbers change.
- `web/index.html`'s payoff chart legend text is slightly stale relative to what's actually plotted (says "protected (your position + put)" vs. "unprotected"; actually plots only the option's own P/L curve from the server). Cosmetic, worth a one-line fix before a screenshot-heavy submission.

---

## Design rules that must never be violated

1. **`src/core.ts` is the only module that touches the Thetanuts SDK.** `aave.ts` goes through `core`'s `readClient`/`signerFromEnv`/`tokenSymbol`. `intent.ts` and `judgment.ts` import only *types* from `core`. `server.ts` and `cli.ts` are thin faces. If you find yourself importing `@thetanuts-finance/thetanuts-client` anywhere except `core.ts`, stop.
2. **The LLM (`src/intent.ts`) never produces a number the user sees.** It only ever outputs `{asset, floorUsd, horizonDays}`, and that output is strictly validated before anything downstream touches it.
3. **No fabricated numbers, anywhere.** Every price, premium, payoff, and "amount paid" figure traces to a live SDK call or an empirical receipt read (`sumDebits`) — never an assertion, an estimate, or a placeholder that could be mistaken for real data.
4. **Approve exact amounts, never `MaxUint256`.** Both the OptionBook approval (`core.ts`) and the Aave supply approval (`aave.ts`) follow this.
5. **Fail loud, fail cheap.** Every real send is preceded by a free simulation (`callStaticFillOrder` / Aave's `staticCall`). Capping, staleness, and coverage-gap situations are always surfaced to the user, never silently handled.
6. **`/api/execute` requires `confirm: true`.** This is the one deliberate human checkpoint before real funds move. Don't remove or weaken it.
7. **Base mainnet only, chainId 8453.** There is no testnet config in the SDK; don't add one.

---

## If you're an AI agent picking this up next

- Read `src/core.ts` in full before touching anything — it's ~430 lines and it's the whole ballgame.
- If asked to add a feature, ask whether it belongs in `core.ts` (protocol logic), a new pure module like `judgment.ts`/`intent.ts` (decision logic), or the `server.ts`/`cli.ts`/`web/index.html` faces (presentation only). Presentation layers should never compute a number `core.ts` could compute instead.
- Before claiming anything is "done," run `npm test` and `npx tsc --noEmit`, and if your change touches the execute/simulate/deposit path, trace through it by hand against `core.ts`'s actual current function signatures — they've shifted subtly across this project's history (e.g. `quote()`'s second argument is a *requested* amount that may get capped, not the amount that will actually be spent) and stale assumptions are the most common source of real bugs here.
- If you're touching `web/index.html`'s execute/simulate flow, fix Known Residual Issue #1 above first, or at minimum don't make it worse.
- Never create a `.env` file, never fabricate a private key or API key, never attempt to move real funds without a human explicitly funding a wallet and confirming they want you to.

---

## Prior AI agent's sign-off (verbatim, for continuity)

The following is the handoff summary from the agent that carried out the 11-task hardening pass this codebase currently reflects (fixing the 8 attacks in `FableAudit.md` and building the NL/judgment/API/UI surface). Preserved here verbatim since it documents *why* several non-obvious decisions were made, not just what changed:

> ## Rulings I made
>
> 1. **Repo bootstrap sequencing** — the project had no git repo when execution started, so Task 1 (git init + first commit) ran directly in the project root; I created the isolated worktree only after `main` existed. *Cost if wrong: negligible — trivial to inspect.*
> 2. **Native worktree tool unusable** — `EnterWorktree` failed to detect the freshly-created repo, so I used the documented git-worktree fallback instead. *Cost if wrong: none — this is the skill's own fallback path.*
> 3. **No credentials in this environment** — no `.env` exists, so every step that would spend real money (Aave deposit, the real options fill) was never executed here; I never sourced, requested, or fabricated a private key. *This is a hard safety boundary, not a judgment call.*
> 4. **Task 3 plan defect** — the plan's own sample code threaded the raw (uncapped) spend amount into `simulate()`/`execute()` instead of the capped amount. Fixed, overriding the plan's literal text. *Cost if wrong: low — caught immediately by Task 3's own review.*
> 5. **Task 6 plan defect** — the plan's greedy JSON-extraction regex was fragile against realistic LLM output shapes. Fixed with a balanced-brace scanner. *Cost if wrong: low — degrades to a safe rejection either way.*
> 6. **Task 11's real trade deliberately not executed** — no funded wallet exists here; README's Proof section is an honest placeholder, not a fabricated hash. This step still needs to happen: you'll need to fund a burner wallet and run the demo runbook yourself before submitting.
> 7. **One Critical finding parked, not fixed** — the final review caught a real gap: after the fix-wave closed the obvious duplicate-fill path (Execute button silently re-arming after a failed fill), the re-review found a second door left open — clicking "Simulate fill" again after a post-fill error re-arms the Execute button with no confirmation, in `web/index.html`'s `runSimulate()`. Per this skill's rule against a second automated fix wave, I did not dispatch another fix — I'm surfacing it here instead. This is the one thing I'd fix before ever running the real, funded demo: `runSimulate()` unconditionally writes `execBtn.disabled = !sim.ok`, bypassing the new manual-clear gate. *Cost if wrong (left unfixed and hit on stage): a plausible real duplicate $10 fill — low dollar cost per the hackathon's own guidance, but an avoidable mainnet mistake.*
>
> ## What shipped
>
> All 8 audit attacks fixed (collateral filter, asset filter, budget capping, coverage-gap honesty, Aave helper, stop-loss table honesty, deposit safety), plus the full NL/judgment/API/UI surface and submission docs — 40 passing tests, clean architecture (`core.ts` remains the sole Thetanuts-touching module).
