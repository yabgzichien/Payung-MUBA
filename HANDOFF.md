# HANDOFF.md — for the next AI agent working on this codebase

This file is written for an AI agent (or human) picking up this project cold. It covers what the project is, how the code is structured, what's safe to change, what's load-bearing, and the exact state this branch was left in.

---

## What this project is

**Payung** ("umbrella" in Malay) is an options-protection product built on the Thetanuts SDK, running live on **Base mainnet** (chainId 8453). A user states a plain-language constraint — "I need my ETH worth at least $2,300 in two weeks" — and the system:

1. Parses that sentence into `{asset, quantity, floorTotalUsd, horizonDays}` via an LLM (Gonka Router) — **the LLM's only job, ever**.
2. Queries the live Thetanuts orderbook, filters to currently-fillable put options that actually match (correct underlying, correct side, dollar-denominated collateral, roughly the right window) and ranks them by distance to derived `impliedStrike(spec)`.
3. Prices the best match using the protocol's own math (never invented numbers).
4. Shows a unified price chart (Coinbase candles, Chainlink spot, strike, expiry, payoff gutter) and a deterministic (non-LLM) judgment: is this premium worth it?
5. Simulates the exact transaction for free (`callStaticFillOrder`).
6. Only on explicit user confirmation, executes for real and returns a BaseScan-verifiable transaction hash.

Built for **MUBA Hacks 2026**, targeting both Thetanuts tracks (SDK Product, AI × Options). Full pitch/context: [PROJECT.md](PROJECT.md). Detailed behavioral spec: [Payung_Spec.md](Payung_Spec.md). Original security/product audit that this branch's work responds to: [FableAudit.md](FableAudit.md).

**The one sentence that governs every design decision in this codebase:** *the LLM never produces a number the user sees.* Every price, premium, spot, candle, and payoff figure traces to a live SDK call, Chainlink feed, Coinbase endpoint, or an empirical read of a transaction receipt — never a guess, never an estimate, never client-side math reconstructing what the server already computed correctly.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (ESM, `"type": "module"`) | Intra-project imports use the `.js` suffix even though source is `.ts` (e.g. `import { readClient } from './core.js'`) — standard Node ESM + `tsx` convention. |
| Runtime | Node.js 18+ | No bundler, no build step. `tsx` runs `.ts` files directly. |
| Chain SDK | `@thetanuts-finance/thetanuts-client` `^0.3.0` | The only package that talks to the Thetanuts protocol. Imported exclusively from `src/core.ts`. |
| Chain interaction | `ethers` `^6.13.0` | Providers, wallets, contract calls (Aave `supply`, Chainlink `latestRoundData`), address/BigInt utilities. |
| Chain | Base mainnet, chainId `8453` | No testnet config exists in the SDK — don't add one. |
| Blockchain protocol | Thetanuts V4 (OptionBook) | Decentralized options; cash-settled puts/calls, `fetchOrders`/`previewFillOrder`/`callStaticFillOrder`/`fillOrder`. |
| Collateral bridging | Aave V3 on Base | `STRATEGY_VAULT_CONFIG.aave.pool`, used to mint `aBasUSDC` from raw USDC (`src/aave.ts`). |
| Price feeds / Spot | Chainlink AggregatorV3 on Base | `chainConfig.priceFeeds[asset]` read by `src/spot.ts` via plain provider; same feed the option settles against. |
| Candle history | Coinbase Exchange Public API | `GET /products/{id}/candles` fetched by `src/spot.ts`, normalized to `{t,o,h,l,c}`. |
| AI / LLM | Gonka Router (OpenAI-compatible chat completions API) | Model configurable via `.env` (`GONKA_MODEL`, default `moonshotai/Kimi-K2.6`). Used ONLY for NL→spec transcription in `src/intent.ts` — never for pricing or judgment. |
| HTTP server | Node's built-in `node:http` | No Express/Fastify/etc. — thin routes (`src/server.ts`). |
| Frontend | Vanilla HTML/CSS/JS, single file (`web/index.html`) | No framework, no bundler, no build step. Talks to the API via `fetch`. |
| CLI | `tsx` running `src/cli.ts` directly, wired through `npm run <script>` | No CLI framework (no yargs/commander) — a manual `switch` on `process.argv`. |
| Testing | Vitest `^4.1.11` | Pure-function unit tests only (`tests/*.test.ts`); zero network access by design. Live/network behavior is verified ad hoc via the CLI, never inside the suite. |
| Type checking | TypeScript `^5.6.0`, `tsc --noEmit` | No separate lint step configured. |
| Env config | `dotenv` `^16.4.5` | Loads `.env` (gitignored) for `PRIVATE_KEY`, `BASE_RPC_URL`, `GONKA_API_KEY`, `GONKA_BASE_URL`, `GONKA_MODEL`. |
| Package manager | npm (see `package-lock.json`) | No monorepo tooling — one `package.json` at the repo root. |

No database, no auth system, no message queue, no bundler, no CSS framework. This is deliberate — the whole product is a thin, auditable layer over a live on-chain orderbook, and the tech stack stays exactly as thin as that requires.

---

## Code structure

```
src/
  spec.ts       — ProtectionSpec + impliedStrike. ZERO imports, deliberately: intent.ts needs
                  impliedStrike at RUNTIME, and rule 1 forbids it value-importing core.ts.
                  Do NOT merge this back into core.ts.
  spot.ts       — Coinbase candle history + Chainlink spot for the chart. Must never import the
                  Thetanuts SDK, not even as a type; takes (feed, provider) as plain arguments.
  core.ts       — THE ONLY MODULE THAT TOUCHES THETANUTS. Everything else is a thin face over this.
  aave.ts       — USDC → aBasUSDC deposit helper (buyable puts settle in aBasUSDC, not raw USDC)
  intent.ts     — NL → ProtectionSpec via Gonka Router. Strictly validates the LLM's 4-field output.
  judgment.ts   — Deterministic (NOT LLM) premium-vs-value verdict + coverage-gap honesty
  server.ts     — Thin node:http JSON API over core.ts/spot.ts, plus static serving of web/
  cli.ts        — Terminal interface: book, whoami, quote, simulate, execute, preflight, deposit, ask
web/
  index.html    — The product UI. Vanilla JS, no framework, no build step. Talks to server.ts's API.
tests/
  fixtures.ts          — makeCandidate() factory + fake token/feed addresses (tests never touch network)
  implied-strike.test.ts — pure derivation tests for impliedStrike
  spot.test.ts         — pure candle normalization + granularity calculation tests
  decode.test.ts        — pure order-decoding
  filter.test.ts        — candidate filter ranking by impliedStrike (asset, side, collateral, window)
  fill-safety.test.ts   — budget capping, staleness guard, receipt-derived paid amount
  coverage.test.ts      — coverage-gap math
  aave-plan.test.ts     — Aave deposit decision logic
  intent.test.ts        — NL parsing + validation (fake LLM client, zero network)
  judgment.test.ts      — premium-vs-value verdict logic
  wire.test.ts          — HTTP wire-format helpers (candidateId, toWire, jsonSafe)
docs/
  demo-runbook.md               — pre-demo checklist + pitch order for the hackathon
  superpowers/plans/...          — the implementation plans for historical record
PROJECT.md        — pitch, Q&A, track fit, pricing table, status checklist
Payung_Spec.md    — the detailed behavioral spec (functional requirements, edge cases)
FableAudit.md     — the original security/product audit this branch's work fixes
README.md         — setup instructions, "Run it," proof-of-real-trade section (placeholder)
```

### `src/core.ts` — the one module that matters most

Read this file first, always. It owns every Thetanuts SDK call. Key exports, in the order data flows:

- `readClient()` / `writeClient()` — read-only vs. signing SDK clients. `writeClient()` throws without `PRIVATE_KEY`.
- `signerFromEnv(provider)` — extracted so `aave.ts` can sign without a second env-parsing path.
- `Candidate` (type) — a single decoded live order: side, strike, expiry, price, `priceFeed` (which underlying), `makerBudget` (in the order's own collateral-token units), greeks.
- `decodeOrder(o, scale, nowSec, collateralDec)` — **pure**, exported for tests. Decodes one raw SDK order.
- `getBook(client?)` — fetches + decodes every live order. **Never call this directly for a user-facing decision — always go through `findCandidates`.**
- `ProtectionSpec` (type) — `{asset: 'ETH'|'BTC', quantity, floorTotalUsd, horizonDays}`, the parsed user intent. Defined in `src/spec.ts` and re-exported from this file, so existing `from './core.js'` imports keep working. `floorTotalUsd` is the TOTAL value the whole holding must be worth, never a per-unit price — the per-unit strike a match is ranked against is derived via `impliedStrike(spec) = floorTotalUsd / quantity`. Do not add a second stored per-unit field; every caller reads `impliedStrike`, so the total and per-unit readings can never drift apart (this fixed a real matching bug where "$798 for 0.32 ETH" was matched against an $798 strike instead of the correct $2,493.75).
- `FilterConfig` (type) + `filterCandidates(book, spec, cfg)` — **the safety-critical filter, pure and fully unit-tested.** Filters to: puts only, maker-is-seller only (so you're buying protection, never accidentally writing options), correct underlying asset (`priceFeed` match), dollar-denominated collateral only, roughly the right expiry window (0.6x–2.5x horizon), ranked by absolute distance to `impliedStrike(spec)`, capped at 8 candidates.
- `tokenSymbol` / `dollarTokens` — live-discovers which collateral tokens are dollar-denominated (checks a small hardcoded allowlist of known-good addresses first, falls back to a `symbol().endsWith('USDC')` heuristic for tokens not yet in the allowlist).
- `findCandidates(spec, client?)` — the actual entry point everything else calls. Thin wrapper: `getBook` → `filterCandidates`.
- `capSpend(requestedUsdc, makerBudget)` — caps a fill to what the maker can actually absorb, never silently.
- `assertFillable(c, nowSec, bufferSec?)` — refuses to send against an order expiring within the buffer.
- `sumDebits(logs, token, from)` — reads what actually left the wallet from a transaction receipt's Transfer logs. This is how "max loss" is reported — **empirically, never asserted**.
- `Quote` (type) + `quote(candidate, requestedUsdc, client?)` — prices a fill via `previewFillOrder`, applying `capSpend`.
- `simulate(candidate, collateralUsdc, client?)` — **free** dry run via `callStaticFillOrder`. **Note: defaults to `writeClient()`, so it needs `PRIVATE_KEY` even though it's free** — a `callStatic` call needs a signer address to run against. This is SDK-driven, not a bug, but it means "free simulation" still requires wallet setup. Documented in README.
- `execute(candidate, spendUsdc, client?)` — the real fill. Order: `assertFillable` → `simulate` → `ensureAllowance` (exact amount, never MaxUint256) → `fillOrder`. **Never throws after `fillOrder()` has returned successfully** — if the paid amount can't be determined from receipt logs, returns `paidUsd: null` rather than fabricating $0 or throwing.
- `payoffCurve(q, spotRange, points)` — pure math for the UI's chart. No network, no LLM.

### Confirmed technical facts

- `chainConfig.priceFeeds.ETH` (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`) and `.BTC` (`0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F`) are genuine Chainlink AggregatorV3 proxies on Base — both answer `latestRoundData()` and `decimals()` (8), ETH's `description()` returns "ETH / USD". This is what makes the chart's spot marker the actual settlement price rather than a second opinion.
- The public `mainnet.base.org` RPC rate-limits these reads under light load (observed: "missing revert data" on a call that succeeded seconds earlier), which is why `fetchSpot` retries once.

### `src/aave.ts` — collateral bridging

Buyable puts settle in `aBasUSDC` (Aave-wrapped USDC), not raw USDC. `planDeposit(...)` is a pure decision function (none / deposit-the-shortfall / blocked); `ensureDollarCollateral(...)` executes it — exact-amount approval, `staticCall` dry run, then the real Aave `supply`.

### `src/intent.ts` — the entire AI surface

`gonkaLlm()` is the transport (OpenAI-compatible chat completions). `parseIntent(text, llm)` calls it, extracts the first *balanced* JSON object from the response (a hand-rolled brace-depth scanner respecting string literals), and `validateSpec(obj)` strictly validates the four fields (`asset` must be exactly `'ETH'`/`'BTC'`, `quantity` > 0, `floorTotalUsd` in `[1, 10_000_000_000]`, `horizonDays` in `[1, 90]`, and derived `impliedStrike` in `[1, 10_000_000]`). Anything else — off-topic input, out-of-range values, malformed shape — throws a clear, honest error. **This module can never produce a number that reaches the user**; it only ever produces a filter over live data.

### `src/judgment.ts` — the agent's visible "judgment," deliberately not an LLM call

`judgeQuote(quote, coverageGapDays)` computes premium-as-percent-of-floor and buckets it: ≤5% reasonable, 5–10% expensive, >10% not-worth-it (thresholds from `PROJECT.md`'s own pricing guidance). Also folds in a coverage-gap warning if the option's protection ends before the user's stated deadline. **Deliberately deterministic** — judgment over real numbers should be auditable, not a model guess.

### `src/server.ts` — the HTTP API

Plain `node:http`, no framework (thin routes). Binds to `127.0.0.1` only. Routes:

- `POST /api/parse` `{text}` → `{spec}` — wraps `parseIntent`
- `POST /api/candidates` `{spec}` → `{candidates: [...]}` — wraps `findCandidates`, populates an in-memory cache keyed by a stable id (candidates carry BigInts + raw SDK objects that must never cross the wire)
- `POST /api/quote` `{id, spendUsdc}` → `{quote, judgment, payoff}`
- `POST /api/simulate` `{id, spendUsdc}` → `{ok, error?}`
- `POST /api/execute` `{id, spendUsdc, confirm}` → `{hash, explorer, paidUsd}` — **requires `confirm: true` or 400s**; this is the one deliberate human-confirmation gate before real money moves
- `GET /api/history?asset=ETH&days=14` → `{candles, spot, historySource, spotError, historyError}` (60s cache)
- `GET /*` → static files from `web/`

Client-input errors (bad spec, unknown candidate id) are tagged with a `ClientError` marker class and surface as 400; genuine server/SDK errors surface as 500.

### `web/index.html` — the product UI

Single file, vanilla JS, no build step, no framework. A 4-step flow (state constraint → live candidates → payoff + judgment + unified chart → simulate/execute). Fully wired to the real API. Talks to every route in `server.ts` above.

### `src/cli.ts` — terminal interface

`book` (read-only book dump), `whoami` (wallet + balances), `quote`/`simulate`/`execute` (share one code path, args: `<quantity> <floorTotalUsd> <collateralUsdc> [horizonDays=14]`), `preflight` (pre-demo freshness/fillability check, args: `<quantity> <floorTotalUsd> [horizonDays=14]`), `deposit` (Aave top-up), `ask` (NL entry point). Run via `npm run <name> -- <args>`.

---

## How to run it

```bash
npm install
cp .env.example .env   # fill in PRIVATE_KEY (burner wallet), BASE_RPC_URL, GONKA_API_KEY
npm test                # pure-function tests, zero network calls
npm run book             # live read against Base mainnet, no wallet needed
npm run quote -- 1 2300 10 14 # quote for 1 ETH with $2300 total floor
npm run web               # http://localhost:8787 — the full product
```

**Wallet requirement, precisely:** browsing, asking (NL parsing), viewing candidates, and getting a quote + payoff chart need **no** wallet. Simulating and executing both need `PRIVATE_KEY` in `.env` — even "free" simulation calls `callStaticFillOrder`, which needs a signer address.

---

## Testing philosophy — read this before adding code

- Every pure function (filtering, decoding, capping, judgment, intent validation, deposit planning, candle normalization) is unit tested in `tests/` with **zero network access**. `tests/fixtures.ts` provides fake-but-valid-shaped addresses for this.
- Live-network behavior is verified separately, ad hoc, via the CLI (`npm run book`, `npm run quote -- ...`) — never inside `vitest`.
- If you add a new piece of decision logic (a new filter, a new cap, a new validation rule), extract it as a pure function first and test it before wiring it into `core.ts`'s async wrappers or the CLI/server.
- Run `npm test` (must stay green) and `npx tsc --noEmit` before considering any change done.

---

## Known residual issues (read before touching related code)

### 1. First real on-chain fill has not been executed

No `.env`/`PRIVATE_KEY` has existed in any environment this code has run in so far. `README.md`'s "Proof" section is an honest, explicit placeholder (bracketed instructions, not a fake-looking hash or invented dollar figure) — **never replace a placeholder like this with an invented value; only a real transaction's real hash belongs there.** Before hackathon submission, a human needs to: fund a burner wallet with ~$20 USDC + gas on Base, follow `docs/demo-runbook.md`'s "Days before" checklist, and paste the real BaseScan URL + paid amount into `README.md`.

### 2. Minor, deferred, non-blocking

- `dollarTokens()`'s address allowlist is small (USDC + aBasUSDC on Base mainnet) and falls back to a `symbol().endsWith('USDC')` heuristic for anything not in it — a reasonable defense-in-depth tradeoff, not a full solution, if the live book ever quotes a new dollar-denominated collateral token.
- The CLI and web UI both use illustrative defaults (1 ETH, $2300 total floor, 14 days) in docs and CLI fallbacks.

---

## Design rules that must never be violated

1. **`src/core.ts` is the only module that touches the Thetanuts SDK.** `aave.ts` goes through `core`'s `readClient`/`signerFromEnv`/`tokenSymbol`. `intent.ts` and `judgment.ts` import only *types* from `core`. They may value-import `src/spec.ts`, which is dependency-free by construction. `src/spot.ts` reaches the chain through an `ethers.Provider` handed to it by `server.ts`, never through the SDK. If you find yourself importing `@thetanuts-finance/thetanuts-client` anywhere except `core.ts`, stop.
2. **The LLM (`src/intent.ts`) never produces a number the user sees.** It only ever outputs `{asset, quantity, floorTotalUsd, horizonDays}`, and that output is strictly validated before anything downstream touches it. It is explicitly forbidden from computing per-unit strike prices.
3. **No fabricated numbers, anywhere.** Every price, premium, payoff, spot, candle, and "amount paid" figure traces to a live SDK call, Chainlink feed, Coinbase endpoint, or an empirical receipt read (`sumDebits`) — never an assertion, an estimate, or a placeholder that could be mistaken for real data.
4. **Approve exact amounts, never `MaxUint256`.** Both the OptionBook approval (`core.ts`) and the Aave supply approval (`aave.ts`) follow this.
5. **Fail loud, fail cheap.** Every real send is preceded by a free simulation (`callStaticFillOrder` / Aave's `staticCall`). Capping, staleness, and coverage-gap situations are always surfaced to the user, never silently handled.
6. **`/api/execute` requires `confirm: true`.** This is the one deliberate human checkpoint before real funds move. Don't remove or weaken it.
7. **Base mainnet only, chainId 8453.** There is no testnet config in the SDK; don't add one.

---

## If you're an AI agent picking this up next

- Read `src/core.ts` in full before touching anything — it owns protocol interaction.
- If asked to add a feature, ask whether it belongs in `core.ts` (protocol logic), a new pure module like `spec.ts`/`spot.ts`/`judgment.ts`/`intent.ts` (decision logic), or the `server.ts`/`cli.ts`/`web/index.html` faces (presentation only). Presentation layers should never compute a number `core.ts` or `spot.ts` could compute instead.
- Before claiming anything is "done," run `npm test` and `npx tsc --noEmit`.
- Never create a `.env` file, never fabricate a private key or API key, never attempt to move real funds without a human explicitly funding a wallet and confirming they want you to.
