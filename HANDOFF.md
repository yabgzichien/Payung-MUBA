# HANDOFF.md — for the next AI agent working on this codebase

This file is written for an AI agent (or human) picking up this project cold. It covers what the project is, how the code is structured, what's safe to change, what's load-bearing, and the exact state this branch was left in.

---

## What this project is

**Payung** ("umbrella" in Malay) is an options-protection product built on the Thetanuts SDK, running live on **Base mainnet** (chainId 8453). A user states a plain-language constraint — "I need my ETH worth at least $2,300 in two weeks" — and the system:

1. Parses that sentence into `{asset, quantity, floorTotalUsd, horizonDays}` via an LLM (Gonka Router) — **the LLM's only job, ever**.
2. Queries the live Thetanuts orderbook, filters to currently-fillable put options that actually match (correct underlying, **correct side — the user always BUYS, never writes**, dollar-denominated collateral, roughly the right window) and ranks them by distance to derived `impliedStrike(spec)`.
3. Prices the best match using the protocol's own math (never invented numbers).
4. Shows a unified price chart (Coinbase candlesticks, live Chainlink spot, strike floor, and expiry protection timeline) and a deterministic (non-LLM) judgment: is this premium worth it?
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
  aave.ts       — USDC → aBasUSDC deposit helper (buyable puts quote in aBasUSDC, so the PREMIUM is paid in it; never for collateral — buyers post none)
  intent.ts     — NL → ProtectionSpec via Gonka Router. Strictly validates the LLM's 4-field output.
  judgment.ts   — Deterministic (NOT LLM) premium-vs-value verdict + coverage-gap honesty
  server.ts     — Thin node:http JSON API over core.ts/spot.ts, plus static serving of web/
  cli.ts        — Terminal interface: book, whoami, quote, simulate, execute, preflight, deposit, ask
web/
  index.html    — The product UI. Vanilla JS, no framework, no build step. Talks to server.ts's API.
tests/
  fixtures.ts          — makeCandidate() factory + fake token/feed addresses (tests never touch network)
  implied-strike.test.ts — pure derivation tests for impliedStrike
  spot.test.ts         — pure candle normalization + dynamic granularity calculation tests
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

---

## Module Deep-Dives

### `src/spec.ts` — pure user intent and strike derivation

Contains the core domain type `ProtectionSpec` (`{asset: 'ETH'|'BTC', quantity: number, floorTotalUsd: number, horizonDays: number}`) and pure `impliedStrike(spec) = spec.floorTotalUsd / spec.quantity`.
- **Zero imports**: It has no external or internal dependencies so both `src/intent.ts` (LLM parser) and `src/core.ts` (Thetanuts protocol) can import it without cyclic dependencies or pulling heavy SDKs into pure unit tests.
- `floorTotalUsd` represents the *total portfolio value* the user needs to protect, not a per-unit price. The per-unit strike price is always derived via `impliedStrike`.

---

### `src/spot.ts` — candlestick history & live Chainlink spot

Owns price history normalization and live spot pricing for the unified chart:

1. **Coinbase Candlesticks (`fetchHistory`, `toCandles`)**:
   - Fetches public OHLC candles from `https://api.exchange.coinbase.com/products/{ETH-USD|BTC-USD}/candles`.
   - **Coinbase Row Order Gotcha**: Coinbase returns `[time, low, high, open, close, volume]` — note that `low` and `high` precede `open` and `close`. `toCandles` maps this into `{ t: row[0], l: row[1], h: row[2], o: row[3], c: row[4] }`.
   - **Dynamic Granularity (`granularityFor`)**: Coinbase limits candle requests to **300 candles maximum**. Rather than a static ladder, `granularityFor(days)` selects the smallest granularity from `[60, 300, 900, 3600, 21600, 86400]` seconds such that `(days * 86400) / g <= 300`. This prevents HTTP 400 errors for any custom horizon from 1 to 90 days.

2. **Live Chainlink Spot (`fetchSpot`)**:
   - Reads directly from the on-chain AggregatorV3 feed that options settle against (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` for ETH/USD, `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` for BTC/USD).
   - **RPC Resilience**: The public Base RPC (`mainnet.base.org`) aggressively rate-limits under sequential calls, returning `"missing revert data"`. `fetchSpot` handles this by:
     - Caching contract `decimals()` permanently per address in memory (halving the RPC calls per read).
     - Retrying up to 3 times with exponential backoff (`[200ms, 600ms, 1500ms]`).
   - **SDK-Free Boundary**: `fetchSpot` takes `(feedAddress, provider)` as plain arguments and **never imports `@thetanuts-finance/thetanuts-client`**.

---

### `src/core.ts` — the one module that touches Thetanuts

Read this file first for any protocol interaction. Key exports:
- `readClient()` / `writeClient()` — read-only vs. signing SDK clients.
- `Candidate` (type) — decoded live order from `fetchOrders()`.
- `filterCandidates(book, spec, cfg)` — pure filtering: puts only, **`takerIsBuyer` (you buy the put)**, asset match, dollar collateral, 0.6x–2.5x horizon window, ranked by absolute distance to `impliedStrike(spec)`. The side predicate is load-bearing and was previously inverted — see [Buying protection needs NO collateral](#buying-protection-needs-no-collateral--previously-inverted-side-bug).
- `capSpend(requestedUsdc, makerBudget, strike, price)` — caps requested size to what the maker's collateral budget can absorb.
- `simulate(candidate, collateralUsdc, client?)` — free dry run via `callStaticFillOrder`.
- `execute(candidate, spendUsdc, client?)` — fill order: simulates first, approves exact amount (never MaxUint256), fills, and reads actual debit from Transfer logs.

---

### `src/server.ts` — JSON API & Candle Cache

Node built-in `node:http` server. Key routes:
- `POST /api/parse` `{text}` → `{spec}` (LLM parsing).
- `POST /api/candidates` `{spec}` → `{candidates}` (ranked offers with `impliedStrike`, `pctVsImpliedStrike`, `pctFromImpliedStrike`).
- `POST /api/quote` `{id, spendUsdc}` → `{quote, judgment, payoff}`.
- `GET /api/history?asset=ETH&days=14` → `{candles, spot, historySource, spotError, historyError}` (60-second in-memory cache).
- `POST /api/simulate` and `POST /api/execute`.

---

### `web/index.html` — UI, Inputs & Unified SVG Chart

Single-file vanilla JS application. Key frontend features:
1. **Synchronized Inputs (Step 1)**:
   - `amount` (e.g. `0.001` ETH)
   - `unitFloor` (Market floor price, e.g. `$2,300` / ETH)
   - `floor` (Total portfolio value floor, e.g. `$2.30`)
   - All inputs are bi-directionally synchronized live as the user types, with a live restated summary sentence.
2. **Unified Candlestick & Protection Chart (Step 3)**:
   - Native SVG (`700x320` viewBox).
   - Time domain: Left 70% represents historical time (`now - days` to `now`); right 30% represents future protection time (`now` to `expiry`).
   - Price Y domain spans candle wicks, spot, and strike floor with 3% margin.
   - Historical green/red candlesticks with high-low wick lines.
   - Live Chainlink spot line (dashed dim) and guaranteed floor strike line (warning color).
   - Shaded semi-transparent green box highlighting the protected zone below the strike from `now` until `expiry`.
   - `chartRenderToken` monotonic counter prevents race conditions when switching candidates.
   - Named data source attribution below the chart.

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

---

## Testing philosophy

- Every pure function (candlestick normalization, granularity math, filtering, decoding, capping, judgment, intent validation) is unit tested in `tests/` with **zero network access**.
- Run `npm test` and `npx tsc --noEmit` before considering any change complete.

---

## Buying protection needs NO collateral — previously-inverted side bug

**Read this before touching order selection, the Aave path, or anything that asks the user for collateral.**

### The rule

Buying a put costs **the premium and nothing else**. If the app ever demands that the user hold or approve `contracts × strike`, that is a **bug**, not a protocol requirement — it means the app has put the user on the **selling** side.

| Side | What you owe | Why |
|---|---|---|
| **Buyer** (what this product does) | premium only | you are paying for the right to sell at the strike |
| **Seller** (never intended here) | `contracts × strike` cash collateral | a written put must guarantee its payout |

### What was wrong

`filterCandidates` selected `!makerIsBuyer`, which kept exactly the orders where **the taker writes the put**. The comment above that line warned "without this you'd be writing naked puts" — the intent was right, the polarity was backwards. `yourSide` was inverted to match, so the UI cheerfully labelled write-the-put orders **"you buy the option"**.

The SDK's `order.isBuyer` field means the **opposite** of what its name suggests. Verified on Base mainnet from a non-maker wallet holding $4.02:

- `isBuyer === true` → a fill needing **$19,721** of `contracts × strike` still reaches the ERC20 **transfer** step. No collateral is demanded. **Taker is the BUYER.**
- `isBuyer === false` → `Panic(0x11)` collateral-short at **every** size, including dust. **Taker is the SELLER.**

Corroborated by a real settled purchase (tx `0x2570c9dd…`): `sellerWasMaker`, and the taker transferred only the $9.999955 premium.

The field is therefore decoded as **`takerIsBuyer`** in `src/core.ts`, named for what the chain actually does. `tests/filter.test.ts` has a regression test pinning the correct side — **do not "simplify" it away.**

### How the failure presented

Because collateral was demanded from a user who should have owed only a premium, the symptoms were confusing and easy to misdiagnose:

- `Panic due to OVERFLOW(17)` — the book subtracts without a balance guard, so "you are short collateral" surfaces as an opaque arithmetic panic with **no readable reason at all**.
- `ERC20InsufficientAllowance(spender, allowance, needed)` — once the balance was sufficient but the approval wasn't. `needed` equals `contracts × strike` **exactly**; that is how the formula was confirmed.

Both are downstream symptoms. If either reappears, **check the side first** — do not treat them as collateral-sizing problems and do not "fix" them by asking the user for more money.

### Consequence — one real position was written

Before the fix landed, a live fill made the burner wallet the **seller** (tx [`0x3e7417c5…`](https://basescan.org/tx/0x3e7417c5c676109e737f540debe95d0aec9477c9797c19f37e626d0c611cff04), `buyer = 0xEcda1D00…`, `seller = 0x22955CE0…`). It received $0.008272 premium and locked **$1.150000 aBasUSDC** as collateral: ETH **$2,300 strike, expires 2026-09-11**, 0.0005 contracts. Max loss is bounded at the $1.15 posted. It is unaffected by the fix and simply runs to expiry.

### Does the Aave / aBasUSDC path still matter?

Partly, and it is worth revisiting. The Aave `supply` helper exists because the *buyable* puts on the live book quote in `aBasUSDC`, so the premium itself must be paid in that token. That is still true. But the large USDC→aBasUSDC conversions users were prompted for were **entirely a product of the side bug** — they were funding a seller's collateral.

Worth evaluating: the book currently carries far more `takerIsBuyer` orders collateralised in **raw USDC** than in aBasUSDC. Restricting to those would remove the Aave step altogether. The one confirmed real protection purchase on this book settled in plain USDC.

---

## Known residual issues

### 0. The buy-side flow has not been proven end-to-end
The side fix, the premium-only requirement, and the re-quote logic are all verified in isolation (86/86 tests pass, live simulations confirm `you buy the option` and a premium-sized requirement). **No successful buyer-side fill has landed yet.** After the first one, decode its `OrderFilled` event and confirm the wallet appears as `buyer`, not `seller` — given this bug shipped once, verify rather than assume.

### 0b. Maker offers live ~96 seconds
`orderExpiryTimestamp` is ~96s from publication, and `assertFillable` refuses anything under 60s remaining — so a prepared order is fillable only in roughly its first 36 seconds. Any preparatory transaction (Aave supply, collateral approval) outlasts that window and leaves the fill targeting a dead order, which reverts **`"Order expired"`** *on-chain* and costs gas. `public/app.js` handles this by re-quoting after any preparatory transaction (step 2b in `runExecute`). Do not remove that; and do not add new pre-fill transactions without re-quoting after them.

### 1. First real on-chain fill has not been executed
No `.env`/`PRIVATE_KEY` has existed in any automated test environment. `README.md`'s "Proof" section is an honest, explicit placeholder — never replace with fake data. Before submission, fund a burner wallet with ~$20 USDC + gas on Base, follow `docs/demo-runbook.md`, and paste the real BaseScan transaction hash into `README.md`.

### 2. Minor, deferred items
- `dollarTokens()` address allowlist is small (USDC + aBasUSDC on Base mainnet) and falls back to a `symbol().endsWith('USDC')` heuristic for tokens not in the list.

### 3. Gas fee is not shown in the UI — TODO
`web/index.html` currently displays only the premium. Add the estimated gas fee (available from the `callStaticFillOrder()` simulation) as its own line item next to the premium, plus a combined total, and label it as an estimate since actual gas can vary slightly by confirmation time. This keeps the display consistent with the project's "no fabricated numbers, show every real cost" rule (design rule #3).

---

## Design rules that must never be violated

1. **`src/core.ts` is the only module that touches the Thetanuts SDK.** `src/spec.ts` is dependency-free. `src/spot.ts` takes an `ethers.Provider` passed from `server.ts` and never imports the SDK.
2. **The LLM (`src/intent.ts`) never produces a number the user sees.** It only transcribes `{asset, quantity, floorTotalUsd, horizonDays}`.
3. **No fabricated numbers, anywhere.** All prices, premiums, spot prices, and candle data trace to live SDK calls, Chainlink AggregatorV3 feeds, or Coinbase Exchange API.
4. **Approve exact amounts, never `MaxUint256`.**
4b. **The user BUYS the put — always. Never writes one.** `filterCandidates` must keep `takerIsBuyer`. A buyer owes the **premium only**; if any code path asks the user to hold or approve `contracts × strike`, that is the side bug resurfacing, not a protocol requirement. `Panic(0x11)` and `ERC20InsufficientAllowance` from the OptionBook are symptoms of being on the wrong side — diagnose the side before touching amounts.
5. **Fail loud, fail cheap.** Real executions are always preceded by free simulations (`callStaticFillOrder`).
6. **`/api/execute` requires `confirm: true`.**
7. **Base mainnet only, chainId 8453.**
