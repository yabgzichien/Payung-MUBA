# HANDOFF.md — for the next AI agent working on this codebase

This file is written for an AI agent (or human) picking up this project cold. It covers what the project is, how the code is structured, what's safe to change, what's load-bearing, and the exact state this branch was left in.

---

## What this project is

**Payung** ("umbrella" in Malay) is a non-custodial options-protection product built on the Thetanuts SDK, running live on **Base mainnet** (chainId 8453). A user states a plain-language constraint — "I need my ETH worth at least $2,300 in two weeks" — and the system provides two protection flows:

### 1. Spot Protection (Single Leg)
1. Parses user text into `{asset, quantity, floorTotalUsd, horizonDays}` via an LLM (Gonka Router) — **the LLM's only job, ever**.
2. Queries the live Thetanuts orderbook, filters to currently-fillable put options that actually match (correct underlying, **correct side — the user always BUYS, never writes**, dollar-denominated collateral, roughly the right window) and ranks them by distance to derived `impliedStrike(spec)`.
3. Prices the best match using the protocol's own math (never invented numbers).
4. Shows a unified price chart (Coinbase candlesticks, live Chainlink spot, strike floor, and expiry protection timeline) and a deterministic (non-LLM) judgment: is this premium worth it?
5. Formats unsigned transactions (`/api/prepare-tx`) for the user's browser wallet to execute. **Payung never signs for user purchases.**

### 2. Precise Protection (Automated Safe-Module Rolls)
When no single put on the book spans the user's full horizon (e.g. 90 days requested, but only 7-14 day puts exist):
1. Calculates a live theoretical Black-Scholes estimate (`src/blackscholes.ts`) chaining shorter legs forward.
2. Offers **Precise Protection** via a 1-owner **Safe** smart-contract wallet owned by the user (`@safe-global/protocol-kit`).
3. User funds the Safe with their roll budget and enables [`PayungRollModule.sol`](contracts/src/PayungRollModule.sol) with strict on-chain bounds (`deadline`, `maxRolls`, `maxPremiumPerRollUsd`, `totalSpendCapUsd`, `targetStrike`).
4. A decentralized **Gelato Web3 Function** keeper polls [`GET /api/precise/next-roll`](app/api/precise/next-roll/route.ts) and calls permissionless `executeRoll()` when the active leg nears expiry (`<= 2` days).
5. The module forwards the fill via `safe.execTransactionFromModule(...)` into Thetanuts OptionBook. **The user's Safe is the on-chain buyer and owner of every put.**
6. The user can cancel anytime via `cancel()`, stopping future rolls while letting active puts run to expiry.
7. **Zero database**: all state is read on-the-fly from the module's on-chain storage and Thetanuts' positions indexer.

Built for **MUBA Hacks 2026**, targeting both Thetanuts tracks (SDK Product, AI × Options). Full pitch/context: [PROJECT.md](PROJECT.md). Detailed behavioral spec: [Payung_Spec.md](Payung_Spec.md). Precise Protection spec: [2026-09-03-precise-protection-design.md](docs/superpowers/specs/2026-09-03-precise-protection-design.md).

**The governing sentence of this codebase:** *the LLM never produces a number the user sees.* Every price, premium, spot, candle, strike, and payoff figure traces to a live SDK call, Chainlink feed, Coinbase endpoint, or empirical read of a contract receipt — never a hallucinated estimate.

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework / UI | Next.js 15 (App Router), React 19, CSS Modules | Client-side wallet interaction (`ethers.BrowserProvider`), responsive UX under `app/`. |
| Language | TypeScript (ESM, `"target": "ES2022"`) | Path alias `@/*` configured to root `./*`. Strict typechecking (`npx tsc --noEmit`). |
| Smart Contracts | Solidity (`^0.8.28`), Foundry | `contracts/` directory. `PayungRollModule.sol`, Safe integration (`ISafe`), deployment scripts, and unit/fork tests. |
| Smart Accounts | Safe (v1.3.0 / v1.4.1), `@safe-global/protocol-kit` `^8.0.6` | Deploys/connects 1-owner Safes for users; executes atomic multisend (`enableModule` + `open`). |
| Keeper Automation | Gelato Web3 Functions (`@gelatonetwork/web3-functions-sdk`, `@gelatonetwork/automate-sdk`) | Serverless Web3 Function (`gelato/resolver.ts`) indexing `CommitmentOpened` events and executing due rolls. |
| Chain SDK | `@thetanuts-finance/thetanuts-client` `^0.3.0` | Talks directly to Thetanuts protocol. Isolated strictly in `src/core.ts`. |
| Chain Interaction | `ethers` `^6.13.0` | Providers, contract calls (Chainlink feeds, Safe calls), calldata encoding. |
| Chain | Base mainnet, chainId `8453` | No testnet config exists in the Thetanuts SDK — do not invent one. |
| Blockchain protocol | Thetanuts V4 (OptionBook) | Cash-settled puts; `fetchOrders`, `previewFillOrder`, `callStaticFillOrder`, `fillOrder`. |
| Price feeds / Spot | Chainlink AggregatorV3 on Base | `ETH/USD` (`0x7104...`), `BTC/USD` (`0x64c9...`) read by `src/spot.ts` and validated by `PayungRollModule.sol`. |
| Historical candles | Coinbase Exchange Public API | `GET /products/{id}/candles` fetched by `src/spot.ts`, normalized to `{t,o,h,l,c}`. |
| AI / LLM | Gonka Router (OpenAI-compatible) | Model configurable via `.env` (`GONKA_MODEL`, default `moonshotai/Kimi-K2.6`). Used ONLY for NL→spec transcription in `src/intent.ts`. |
| Testing | Vitest `^4.1.11` (TS) + Foundry (Solidity) | 229 Vitest tests (pure functions, zero network) + 16 Forge tests (module access control, reverts, limits). |
| Package Manager | npm | Node 18+ runtime. |

No database, no auth system, no backend session store. The on-chain contracts and protocol indexers are the sole sources of truth.

---

## Code structure

```
contracts/
  src/
    PayungRollModule.sol        — Safe module for Precise Protection (open, cancel, permissionless bounded executeRoll)
    interfaces/ISafe.sol        — Minimal ISafe interface for execTransactionFromModule
  test/
    PayungRollModuleOpen.t.sol  — Foundry tests for open(), cancel(), and access control
    PayungRollModuleExecuteRoll.t.sol — 9 Foundry tests for executeRoll() bounds, limits, and reverts
    mocks/MockSafe.sol          — Minimal mock Safe implementing ISafe
  script/
    Deploy.s.sol                — Foundry deploy script for PayungRollModule
gelato/
  resolver.ts                   — Gelato Web3 Function resolver (checks module events + calls /api/precise/next-roll)
  register.ts                   — Script to register the Gelato Automate task
src/
  spec.ts       — ProtectionSpec + impliedStrike. ZERO imports, deliberately.
  spot.ts       — Coinbase candle history + Chainlink spot for the chart. Never imports Thetanuts SDK.
  core.ts       — THE ONLY MODULE THAT TOUCHES THETANUTS SDK. Everything else is a thin face over this.
  intent.ts     — NL → ProtectionSpec via Gonka Router. Strictly validates LLM output.
  judgment.ts   — Deterministic (non-LLM) premium-vs-value verdict + coverage-gap honesty.
  blackscholes.ts — Pure Black-Scholes pricing & IV solving for chained-roll estimates.
  watcher.ts    — Position reader (`positionsFor`) and evaluation engine.
  policy.ts     — Roll decision thresholds (`rollWhenDaysToExpiry = 2`).
  precise.ts    — Pure merge logic combining raw on-chain commitment with indexed positions.
  aave.ts       — USDC → aBasUSDC helper (for orders quoting in aBasUSDC).
  api-shared.ts — ClientError, jsonResponse, requireJsonContentType, withErrorHandling.
app/
  protect/
    page.tsx                    — Step 1: Input goal (NL or structured)
    results/page.tsx            — Step 2: Recommendations, chart, and Precise Protection CTA
    confirm/page.tsx            — Step 3: Transaction confirmation & review
    purchased/page.tsx          — Step 4: Post-purchase receipt & BaseScan link
    precise-setup/page.tsx      — Precise Protection onboarding (deploy Safe, fund, enableModule + open)
    _lib/                       — Shared frontend helpers (safe.ts, wallet.ts, api.ts, FlowState.tsx, Shell.tsx)
  my-protection/page.tsx        — Active positions view + Precise Protection status, spend progress & cancel
  api/
    candidates/route.ts         — POST /api/candidates
    quote/route.ts              — POST /api/quote
    prepare-tx/route.ts         — POST /api/prepare-tx
    positions/route.ts          — GET /api/positions
    history/route.ts            — GET /api/history
    precise/
      commitment/route.ts       — GET /api/precise/commitment?safe=0x...
      prepare-open/route.ts     — POST /api/precise/prepare-open
      prepare-cancel/route.ts   — POST /api/precise/prepare-cancel
      next-roll/route.ts        — GET /api/precise/next-roll?safe=0x...
tests/                          — 32 test files, 229 Vitest tests (fixtures, intent, blackscholes, precise, etc.)
docs/
  superpowers/
    specs/2026-09-03-precise-protection-design.md — Precise Protection architectural spec & tech stack diagram
    plans/2026-09-03-precise-protection.md        — 12-task execution plan (all tasks checked off & committed)
```

---

## Module Deep-Dives

### `contracts/src/PayungRollModule.sol` — Safe module for auto-rolling
- Enabled by the user's Safe. Keys commitments by `safe` address.
- `open(Commitment calldata c)`: Only callable by `c.safe` itself. Stores spend caps, strike target, deadline, and sets `active = true`.
- `executeRoll(address safe, bytes calldata fillOrderCalldata, uint256 usdcAmount, uint256 orderStrike, uint256 orderExpiry)`:
  - **Permissionless**: Any caller (Gelato keeper, user, or Payung cron) can call this.
  - **On-chain bounded**: Verifies `block.timestamp < deadline`, `rollsUsed < maxRolls`, `usdcAmount <= maxPremiumPerRollUsd`, `spentUsd + usdcAmount <= totalSpendCapUsd`, `bytes4(fillOrderCalldata) == 0x11be7f27` (OptionBook `fillOrder`), and that `orderStrike` is within 5% of `targetStrike` adjusted for Chainlink spot moves.
  - Calls `ISafe(safe).execTransactionFromModule(optionBook, 0, fillOrderCalldata, Enum.Operation.Call)`.
  - Increments `spentUsd += usdcAmount` and `rollsUsed += 1`.
- `cancel()`: Callable only by `msg.sender == safe`. Sets `active = false`. Never unwinds active options.

### `src/precise.ts` — Pure merge logic
- Pure function `mergePreciseCommitment(raw, currentLeg, history, assetForFeed)`.
- Reconstructs original `spec` from on-chain `targetStrike`, `quantity1e6`, `createdAt`, and `deadline`.
- Matches current active leg from `positionsFor()` and formats roll history for the UI.
- Unit tested in `tests/precise.test.ts` (zero network calls).

### `app/protect/_lib/safe.ts` — Safe SDK wrapper
- Uses `@safe-global/protocol-kit`.
- `deployOrConnectSafe()`: Connects user's browser wallet, predicts 1-owner Safe address, deploys if not yet deployed.
- `fundSafe(safeAddress, usdcAmount)`: Standard ERC-20 transfer of USDC from user wallet to Safe.
- `enableModuleAndOpen(safeAddress, moduleAddress, openTx)`: Bundles `enableModule(moduleAddress)` and `module.open(...)` into a single atomic Safe multisend transaction signed by the user.

### `app/api/precise/*` — Calldata & status endpoints
- `GET /api/precise/commitment?safe=0x...`: Reads `commitments(safe)` from module contract, queries Thetanuts positions indexer, and merges via `mergePreciseCommitment`.
- `POST /api/precise/prepare-open`: Encodes `open(Commitment)` calldata for the Safe to execute.
- `POST /api/precise/prepare-cancel`: Encodes `cancel()` calldata.
- `GET /api/precise/next-roll?safe=0x...`: Evaluates if the Safe's position is due for a roll (`daysToExpiry <= 2` or no active leg yet), queries Thetanuts book for candidates, quotes best match, and returns `{ due: true, fillOrderCalldata, usdcAmount, orderStrike, orderExpiry }`.

### `gelato/resolver.ts` & `gelato/register.ts` — Keeper automation
- `resolver.ts`: Gelato Web3 Function runner. Reads `CommitmentOpened` event logs from `PayungRollModule` to find active Safes, calls `/api/precise/next-roll?safe=...`, and returns `canExec: true` with `executeRoll` calldata for the first due Safe.
- `register.ts`: Sets up task with Gelato Automate SDK using `dedicatedMsgSender: true`.

---

## Buying protection needs NO collateral — previously-inverted side bug

**Read this before touching order selection, the Aave path, or anything involving collateral.**

### The rule
Buying a put costs **the premium and nothing else**. If the app ever demands that the user hold or approve `contracts × strike`, that is a **bug**, not a protocol requirement — it means the app has put the user on the **selling** side.

| Side | What you owe | Why |
|---|---|---|
| **Buyer** (what this product does) | premium only | you are paying for the right to sell at the strike |
| **Seller** (never intended here) | `contracts × strike` cash collateral | a written put must guarantee its payout |

### What was wrong & how it is fixed
The SDK's `order.isBuyer` field means the **opposite** of what its name suggests:
- `isBuyer === true` → taker is the **BUYER** (pays premium only, posts NO collateral).
- `isBuyer === false` → taker is the **SELLER** (demands `contracts × strike` collateral, reverts with `Panic(0x11)` if short).

This field is decoded as **`takerIsBuyer`** in `src/core.ts`, named for what the chain actually does. `tests/filter.test.ts` has regression tests pinning this side — **do not revert or remove this**.

---

## Design rules that must never be violated

1. **`src/core.ts` is the only module that touches the Thetanuts SDK.** `src/spec.ts` is dependency-free. `src/spot.ts` takes an `ethers.Provider` and never imports the SDK. `src/precise.ts` is pure domain merge logic.
2. **The LLM (`src/intent.ts`) never produces a number the user sees.** It only transcribes `{asset, quantity, floorTotalUsd, horizonDays}`.
3. **No fabricated numbers, anywhere.** All prices, premiums, spot prices, and candle data trace to live SDK calls, Chainlink AggregatorV3 feeds, or Coinbase Exchange API.
4. **Approve exact amounts, never `MaxUint256`.**
5. **The user BUYS the put — always. Never writes one.** `filterCandidates` must keep `takerIsBuyer`. A buyer owes the premium only.
6. **Fail loud, fail cheap.** Real executions are always preceded by free simulations (`callStaticFillOrder`).
7. **Base mainnet only, chainId 8453.**
8. **Auto-roll ("Precise Protection") must never be executed via a server-custodied wallet.** `fillOrder` has no relayer parameter — whoever signs is the buyer of record. Unattended future rolls are executed exclusively through the user's own Safe via `PayungRollModule.sol`. Payung never custodies user funds or option positions.

---

## How to run and verify

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in BASE_RPC_URL, GONKA_API_KEY, and when testing deployment: PAYUNG_ROLL_MODULE_ADDRESS

# 3. Smart contract tests (Foundry)
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts && forge test -vv && cd ..

# 4. TypeScript typecheck
npx tsc --noEmit

# 5. Full unit & integration test suite (Vitest)
npm test

# 6. Run Next.js local development server
npm run dev
# Opens on http://localhost:8787
```

---

## Current state of the repository

All 12 tasks from the [Precise Protection Plan](docs/superpowers/plans/2026-09-03-precise-protection.md) are completed and committed:
- **Phase 1 (Contracts)**: `PayungRollModule.sol`, `Deploy.s.sol`, 16 Foundry tests passing. Dry-run verified against Base mainnet fork.
- **Phase 2 (APIs)**: `src/precise.ts` pure merge, `GET /api/precise/commitment`, `POST /api/precise/prepare-open`, `POST /api/precise/prepare-cancel`, `GET /api/precise/next-roll`.
- **Phase 3 (Frontend)**: Safe SDK wrapper (`app/protect/_lib/safe.ts`), onboarding flow (`app/protect/precise-setup`), results screen button, and `/my-protection` status & cancel section.
- **Phase 4 (Keeper)**: Gelato Web3 Function resolver (`gelato/resolver.ts`), registration script (`gelato/register.ts`), and npm script `npm run gelato:register`.

### What remains before live production launch:
1. **Broadcast Contract Deployment**: Run `forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --broadcast` with a funded deployer key to deploy `PayungRollModule` to Base mainnet.
2. **Set Environment Variables**: Set `NEXT_PUBLIC_PAYUNG_ROLL_MODULE_ADDRESS` and `PAYUNG_ROLL_MODULE_ADDRESS` in production `.env`.
3. **Register Gelato Task**: Run `npm run gelato:register` pointing to the deployed module address and production API base URL.
