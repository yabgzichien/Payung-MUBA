# Payung — Precise Protection (Safe-module auto-roll)

**Date:** 2026-09-03
**Status:** Approved for planning
**Scope:** Main product flow (`app/protect/results`, `app/my-protection`) plus a new on-chain module and a new keeper integration. Builds on [2026-09-02-chained-roll-estimate-design.md](2026-09-02-chained-roll-estimate-design.md) — this spec assumes that feature (the "Or chain shorter puts" estimate card) is already shipped.

---

## 1. Problem statement

The chained-roll estimate card tells a user what covering their full horizon would theoretically cost by chaining several near-dated puts — but it stops at telling them. Today the only action on that card is "Buy this first leg," which starts a single normal purchase; every subsequent leg still requires the user to come back to Payung, days or weeks later, and manually repeat the whole search-and-buy flow before the previous leg expires. Miss that window and the floor evaporates silently.

This spec adds **Precise Protection**: an opt-in path, offered from the same card, where the user authorizes Payung to keep rolling the position forward automatically — buying each new leg as it becomes available on the book — until their stated horizon is covered or they cancel. "Precise" names the outcome from the user's point of view: instead of an estimate of what a chain *might* cost, they get an actual, continuously-maintained floor at (as close as the live book allows to) their exact target, for as long as they keep it funded.

The hard problem this spec solves is **not** the rolling logic — `src/watcher.ts`/`src/policy.ts` already implement "decide whether to roll, find a replacement, execute" and are reused here almost unchanged. The hard problem is **who is authorized to execute a purchase on the user's behalf, days after the user has closed the browser tab**, without that authorization ever amounting to Payung holding or controlling the user's money. See §3.

---

## 2. Invariants

Carried over from the chained-roll-estimate spec, plus new ones this feature must not violate:

1. **The model never originates a number the user sees** (unchanged).
2. **No fabricated numbers** (unchanged) — a roll's actual premium always comes from a live quote at roll time, never a projection.
3. **Payung never custodies user funds and never owns a user's option position.** See §3. This is now [HANDOFF.md](/home/yang/Project/MUBA/HANDOFF.md) design rule 8 and must never be violated by any future change to this feature.
4. **Every roll is bounded on-chain by limits the user themselves approved at setup.** No off-chain policy check is trusted as the only safeguard — the module contract enforces the caps itself, so a compromised or malicious keeper cannot exceed them.
5. **Cancelling stops future rolls only.** The protocol has no early-exit for a put buyer; an already-purchased leg runs to its own expiry regardless of cancellation. The UI must never imply cancellation unwinds an active position.
6. **No new database.** Consistent with the existing zero-database stance (see HANDOFF.md tech stack table) — the module's on-chain storage and Thetanuts' own positions indexer are the only sources of truth.

---

## 3. Custody & signing model

### 3.1 The constraint

`OptionBookModule.fillOrder(orderWithSig, usdcAmount, referrer)` (and its `encodeFillOrder` twin) takes **no taker/beneficiary parameter** — confirmed against the SDK's type declarations (`node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts`). Whoever signs and sends that transaction is the on-chain buyer, unconditionally. The protocol has no relayer or "spend an approved allowance on someone else's behalf" path.

This rules out a pure ERC-20-allowance keeper (pull funds from the user's own EOA and fill on their behalf) — there is nowhere in the protocol for a third party to plug in as executor while the user's own address remains the buyer of record.

### 3.2 The chosen model: Safe + scoped automation module

The user deploys or connects a **Safe** smart-contract wallet they fully own. They fund it with their roll budget and enable a Payung-authored module (`PayungRollModule.sol`, §4) with hard-coded policy limits. From then on:

- **Setup — 2-3 user-signed transactions, once:** deploy/connect Safe → fund it with USDC → enable module + write policy limits (`open()`, §4.2). Can likely be bundled into fewer signatures via a Safe multisend; not required for v1.
- **Every roll after that — zero signatures.** The keeper (§5) triggers `executeRoll()` on the module; the module calls `safe.execTransactionFromModule(...)` against the OptionBook, so **the Safe itself is msg.sender** as seen by the protocol. The Safe — which the user, not Payung, controls end-to-end — is the on-chain buyer and owner of every resulting position.
- **Cancel — one user-signed transaction, any time:** call `cancel()` on the module, or disable the module entirely. Either way this is a transaction the Safe itself must sign; Payung cannot do it on the user's behalf, and does not need to — the module enforces this at the contract level (`msg.sender == safe`).

At no point does Payung's own key sign a transaction that spends the user's money or that could make Payung the recorded buyer of an option. This is the property that makes it safe to reuse the existing `execute()`/`writeClient()` machinery's *decision logic* (`decideRoll`, `findReplacement`) without reusing its *signing* path (`writeClient()`'s burner wallet) — the new module replaces the burner wallet as executor, never supplements it.

### 3.3 Rejected alternative

A custodial keeper (user deposits to a Payung-controlled address; Payung's existing burner wallet executes and holds the resulting positions, honoring payouts from its own ledger) was considered and rejected for the real product flow — it is exactly the pattern [HANDOFF.md](/home/yang/Project/MUBA/HANDOFF.md)'s existing architecture note already warns against (never wire the UI to the server-signing path), and it would make Payung a counterparty the user has to trust rather than a piece of software they can verify. It remains how the existing CLI/agent watcher (`src/watcher.ts --auto`) operates for its own demo wallet — that usage is unaffected and out of scope for this spec.

---

## 4. On-chain module

New top-level `contracts/` directory (Foundry) — this is new tooling for this repo, not an extension of the TypeScript/Vitest stack. **This contract holds real user funds and must have its own test suite and a focused review pass before any real money is put behind it; that is a hard requirement of this feature shipping, not a follow-up.**

### 4.1 Shape

One shared `PayungRollModule.sol`, enabled per-Safe the standard Safe-module way (many Safes enable the same deployed module address; the module keys all state off `msg.sender`/the Safe address passed in).

```solidity
struct Commitment {
    address safe;
    bool isCall;              // always false today — puts only, matches filterCandidates
    address underlyingFeed;   // which Chainlink feed this commitment targets (ETH or BTC)
    uint256 quantity1e6;      // asset amount being protected, 6-decimal scaled — needed to size each roll's fill, mirrors Commitment.contracts in src/commitments.ts
    uint256 targetStrike;     // impliedStrike(spec), 1e8-scaled to match Thetanuts strike encoding
    uint256 createdAt;        // unix seconds — with deadline, lets the UI redisplay the original horizonDays
    uint256 deadline;         // unix seconds — spec.horizonDays resolved to an absolute date at open()
    uint256 maxPremiumPerRollUsd;  // 1e6-scaled (USDC decimals)
    uint256 totalSpendCapUsd;      // 1e6-scaled
    uint256 spentUsd;              // running total, 1e6-scaled
    uint256 maxRolls;
    uint256 rollsUsed;
    bool active;
}

mapping(address safe => Commitment) public commitments;
```

### 4.2 Functions

- **`open(Commitment calldata c)`** — callable only by `c.safe` itself (`msg.sender == c.safe`). Writes the commitment, `spentUsd = 0`, `rollsUsed = 0`, `active = true`. This is the Safe-owner-signed "enable + configure" step from setup.
- **`executeRoll(address safe, bytes calldata fillOrderCalldata, uint256 usdcAmount, uint256 orderStrike, uint256 orderExpiry)`** — **permissionless** (any address may call it). `fillOrderCalldata` is exactly what the SDK's own `client.optionBook.encodeFillOrder(order, usdcAmount, referrer)` already returns — the module never decodes or re-encodes Thetanuts' `OrderWithSignature` struct itself (that struct belongs to an external SDK and mirroring its layout in Solidity would be fragile if it ever changes); it only checks the calldata's leading 4-byte selector matches the OptionBook's known `fillOrder` selector, then forwards it as-is. `orderStrike`/`orderExpiry` are supplied alongside purely so the module can validate them in plain Solidity without decoding the calldata. Reverts unless: `commitments[safe].active`, `block.timestamp < deadline`, `rollsUsed < maxRolls`, `usdcAmount <= maxPremiumPerRollUsd`, `spentUsd + usdcAmount <= totalSpendCapUsd`, `fillOrderCalldata`'s selector matches `fillOrder`, and `orderStrike`/`orderExpiry` fall within the commitment's `targetStrike`/`underlyingFeed` window (same tolerance the off-chain `filterCandidates`/`rankCandidates` already apply — mirrored here, not reinvented). On success: calls `safe.execTransactionFromModule(optionBookAddress, 0, fillOrderCalldata, Call)`, then updates `spentUsd += usdcAmount`, `rollsUsed += 1`.
  - **Permissionless is deliberate, not an oversight:** the module's own checks fully bound what any caller can make it do — nobody can extract more than the user pre-approved, redirect funds elsewhere, or roll into the wrong strike/expiry. Restricting the caller to one designated keeper address would only add a single point of censorship (if that keeper goes down, rolls silently stop) without adding any real safety. Anyone — Gelato, Payung's own backup process, or the user themselves — can nudge a due roll through.
- **`cancel()`** — callable only by `msg.sender == commitments[msg.sender].safe`, i.e. only the Safe itself. Sets `active = false`. Already-open positions are unaffected; they simply run to their own expiry as normal options.
- **View functions and events** for the History UI and the keeper's discovery query: `commitments(address safe)` (public mapping getter); `CommitmentOpened(address safe, uint256 quantity1e6, uint256 targetStrike, uint256 deadline)` from `open()` — this is what the keeper's resolver indexes to find every Safe with a commitment, rather than enumerating on-chain; `RollExecuted(address safe, uint256 strike, uint256 expiry, uint256 premiumUsd, uint256 rollsUsed)` from `executeRoll`; `CommitmentCancelled(address safe)` from `cancel()`.

### 4.3 What this module deliberately does NOT do

- Does not hold funds itself — funds live in the Safe; the module only ever moves them via `execTransactionFromModule` at the moment of a roll.
- Does not select which order to fill — that's still `findCandidates`/`rankCandidates` off-chain, same as every other purchase in this app. The module only verifies the order it's handed is consistent with the commitment's own bounds.
- Does not support partial/early unwind of an active leg (Invariant 5).

---

## 5. Keeper (Gelato Web3 Functions)

- One Web3 Function, registered once by Payung (not per-user). Its resolver reads `CommitmentOpened` events directly off the module (a plain `ethers.Provider` read — genuinely lightweight enough for Gelato's sandboxed runtime) to discover every Safe with a commitment, then calls `GET /api/precise/next-roll?safe=...` (§6) for each — that endpoint holds the actual `ThetanutsClient` and does the SDK-dependent work (checking the current leg, finding a replacement, encoding the fill), so the resolver itself never needs to. The first Safe that endpoint reports `due: true` for becomes the returned `execPayload` calling `executeRoll(safe, fillOrderCalldata, usdcAmount, orderStrike, orderExpiry)`.
- Payung funds one shared Gelato 1Balance account (USDC) so individual users never see a separate Gelato bill; this is an operating cost, not something charged per-roll to the user in v1.
- Confirmed live on Base mainnet (Gelato blog + supported-networks doc, checked 2026-09-03). Distinct from Gelato's **Relay** product for Safe (deprecated **2026-09-01**, three days before this spec, in favor of ERC-4337/paymasters) — Relay is not used anywhere in this design, but the timing is a signal this integration surface moves fast. **Re-verify the exact current Web3 Functions SDK calls at implementation time; do not treat this section's specifics as frozen.**
- Because `executeRoll` is permissionless (§4.2), Gelato going down degrades to "rolls don't happen automatically until someone/something else calls it" rather than "funds are stuck" — no new failure mode beyond "the position isn't rolled in time," which is exactly the failure mode manual use already has today.

---

## 6. Backend / persistence

No new database (Invariant 6). Two existing sources of truth, read fresh on every request:

- **The module contract** — `commitments(safe)` for current policy/spend/roll-count/active state, and its event log (`RollExecuted`, `CommitmentCancelled`) for history.
- **Thetanuts' own positions indexer** — already wired via `positionsFor()` in `src/watcher.ts` — for each individual leg's live status (active/expired/settled).

New module `src/precise.ts` (core.ts stays Thetanuts-only per design rule 1; this is a thin merge layer, not a new SDK touchpoint):

```ts
export type PreciseCommitment = {
  safe: string;
  active: boolean;
  spec: ProtectionSpec;          // reconstructed from targetStrike/quantity1e6/createdAt/deadline — no off-chain record needed
  spentUsd: number;
  totalSpendCapUsd: number;
  rollsUsed: number;
  maxRolls: number;
  currentLeg: ShapedPosition | null;   // from positionsFor(), matched by expiry/strike
  history: { strike: number; expiryIso: string; premiumUsd: number; txHash: string }[]; // from RollExecuted logs
};

export async function readPreciseCommitment(safe: string): Promise<PreciseCommitment | null>;
```

In practice this splits into a pure `mergePreciseCommitment(raw, currentLeg, history, assetForFeed)` (no network, unit-testable with fixtures) plus the async on-chain/indexer reads living in the route handler that calls it — the same split every other route in this app already uses between `src/core.ts`'s pure functions and the `app/api/*/route.ts` orchestration around them.

New API routes, read-only except for calldata preparation (never server-signed — same `/api/prepare-tx` pattern already used everywhere else in this app):

- `GET /api/precise/commitment?safe=0x...` → `PreciseCommitment | null`
- `POST /api/precise/prepare-open` `{spec, safe}` → unsigned `{to, data}` for `open()`, computed the same way `/api/prepare-tx` already derives quote/collateral math — never a server signature.
- `POST /api/precise/prepare-cancel` `{safe}` → unsigned `{to, data}` for `cancel()`.
- `GET /api/precise/next-roll?safe=0x...` → `{due: false} | {due: true, safe, fillOrderCalldata, usdcAmount, orderStrike, orderExpiry}`. This is what lets the Gelato keeper (§5) stay a thin HTTP call: it runs in a sandboxed runtime that cannot hold a live `ThetanutsClient`, so all SDK-dependent work (checking the current leg via `positionsFor()`, finding a replacement via `findCandidates()`/`quote()`, encoding the fill via `client.optionBook.encodeFillOrder()`) happens here instead, server-side, exactly where the rest of this app already does it.

---

## 7. Frontend

### 7.1 Onboarding

New step reachable from the results screen (§7.2): deploy-or-connect a Safe (Safe SDK), fund it with USDC (a normal ERC-20 transfer the user signs, defaulting to `estimatedTotalPremiumUsd` from the existing roll estimate plus a stated buffer — e.g. +20%, clearly labeled as a suggestion, editable), then sign one bundled transaction — via Safe's multisend — that both enables `PayungRollModule` on the Safe and calls its `open()` with the policy limits, prepared server-side by `/api/precise/prepare-open`. Three user-signed transactions total, reusing the existing "prepare on the server, sign with the user's own wallet" pattern already established by `/api/prepare-tx` — no new trust model at the wallet-interaction layer, only a new wallet *type* (Safe instead of a plain EOA).

### 7.2 Results screen

Extends the existing "Or chain shorter puts" card ([app/protect/results/page.tsx](/home/yang/Project/MUBA/app/protect/results/page.tsx)) — same real anchor leg, same theoretical total, same "Buy this first leg →" button, unchanged. A second button is added next to it: **"Set up Precise Protection →"**, which starts §7.1's onboarding flow. Neither button is removed or hidden by the other's presence — a user who just wants the one manual leg keeps that exact path.

### 7.3 History — extends `/my-protection`

Per your direction, this is a new section on the existing [app/my-protection/page.tsx](/home/yang/Project/MUBA/app/my-protection/page.tsx), not a separate route. Below the existing single-position card, a "Precise Protection" section (rendered only when `readPreciseCommitment(wallet.address)` returns non-null) shows: current leg (same shape as the existing active-protection card), cumulative spend vs. cap, rolls used vs. max, a roll history list (from `RollExecuted` events, each linking to BaseScan), and a **"Cancel protection"** button that proposes `/api/precise/prepare-cancel`'s transaction for the user to sign.

---

## 8. Error handling / edge cases

- **Book has nothing to roll into when a leg is about to expire:** same as today's watcher behavior — no action is taken, the position simply expires uncovered from that point forward. The History section must show this plainly (e.g. "Protection lapsed on 2026-10-01 — no live match at roll time"), never silently.
- **Total spend cap reached before the deadline:** `executeRoll` reverts for any roll that would exceed it; the commitment sits `active` but effectively dormant until the user tops up the Safe or the deadline passes. Surfaced in the History section the same way.
- **Gelato has downtime:** covered by permissionless `executeRoll` (§5) — degrades to a missed-window risk, not a stuck-funds risk.
- **User disables the module directly via the Safe UI** (bypassing Payung's own "Cancel" button): `commitments[safe].active` is unaffected on the module side, but `executeRoll`'s `safe.execTransactionFromModule` call will simply fail (module no longer authorized), so no funds move. The History section should treat "module not enabled" and "cancelled" as the same displayed state — Payung has no way to distinguish them cleanly and shouldn't pretend to.

---

## 9. Testing

- **Solidity (new Foundry suite under `contracts/`):** `open()`/`cancel()` access control, every `executeRoll` revert condition in §4.2, the `execTransactionFromModule` call path against a mock OptionBook, and that `cancel()` never touches an already-open position.
- **TypeScript:** `tests/precise.test.ts` for `readPreciseCommitment()`'s merge logic (module state + `positionsFor()` + event-log parsing), fixture-driven the same way `tests/roll-estimate.test.ts` is — no network.
- No changes needed to `decideRoll`/`findReplacement` (`src/policy.ts`/`src/watcher.ts`) — reused as-is for the keeper's resolver logic.

---

## 10. Explicitly out of scope

- Early unwind/sell-back of an already-purchased leg — the protocol has no such mechanism for buyers.
- Multi-asset or multi-commitment Safes — one commitment per Safe for v1; a Safe that already has an open commitment cannot open a second one until it cancels or completes.
- Any change to the existing manual "Buy this first leg" flow, or to `src/watcher.ts --auto`'s CLI/burner-wallet demo path — both are reused/untouched, not replaced.
- Gas sponsorship / making rolls free for the user beyond Payung funding the shared Gelato 1Balance account — if per-roll costs need passing through to users later, that's a separate pricing decision.

---

## 11. Tech Stack & System Architecture

### 11.1 Architecture Diagram

```mermaid
flowchart TD
    subgraph Client ["Client Tier (Browser)"]
        UI["Next.js App Router (React 19)<br/>app/protect/precise-setup<br/>app/my-protection"]
        SafeSDK["Safe Protocol Kit (@safe-global/protocol-kit)<br/>deployOrConnectSafe() / fundSafe() / enableModuleAndOpen()"]
        Wallet["User Injected Wallet (EOA / MetaMask)"]
    end

    subgraph Backend ["Backend Tier (Next.js Node.js Server)"]
        API_Open["POST /api/precise/prepare-open<br/>Unsigned open() calldata"]
        API_Cancel["POST /api/precise/prepare-cancel<br/>Unsigned cancel() calldata"]
        API_NextRoll["GET /api/precise/next-roll<br/>Finds candidates & encodes fillOrder"]
        API_Commitment["GET /api/precise/commitment<br/>Reads module & merges positions"]
        PreciseMerge["src/precise.ts<br/>mergePreciseCommitment() (Pure domain logic)"]
        ThetanutsCore["src/core.ts & @thetanuts-finance/thetanuts-client<br/>readClient(), findCandidates(), quote()"]
    end

    subgraph Keeper ["Automation Tier (Gelato Cloud)"]
        GelatoResolver["Gelato Web3 Function (gelato/resolver.ts)<br/>Queries CommitmentOpened logs<br/>Polls /api/precise/next-roll"]
        GelatoExec["Gelato Dedicated Msg Sender<br/>Calls executeRoll() on Base"]
    end

    subgraph OnChain ["On-Chain Tier (Base Mainnet 8453)"]
        UserSafe["User Safe Smart Account<br/>(1-owner Safe, holds user USDC)"]
        RollModule["PayungRollModule.sol<br/>- mapping commitments[safe]<br/>- open() [Safe only]<br/>- cancel() [Safe only]<br/>- executeRoll() [Permissionless, on-chain bounded]"]
        OptionBook["Thetanuts OptionBook (0x11be7f27)<br/>fillOrder(orderWithSig, usdcAmount)"]
        ChainlinkFeeds["Chainlink AggregatorV3<br/>ETH/USD & BTC/USD Price Feeds"]
    end

    %% Interactions
    Wallet -->|Signs Safe deployment, funding, enableModule+open| UserSafe
    UI -->|Requests unsigned calldata| API_Open
    UI -->|Requests unsigned calldata| API_Cancel
    UI -->|Reads status & history| API_Commitment
    API_Commitment -->|Reads state| RollModule
    API_Commitment -->|Pure merge| PreciseMerge

    GelatoResolver -->|Discovers active Safes| RollModule
    GelatoResolver -->|Checks due rolls| API_NextRoll
    API_NextRoll -->|Selects orders| ThetanutsCore
    ThetanutsCore -->|Reads orderbook| OptionBook

    GelatoExec -->|Calls executeRoll(safe, calldata, amount...)| RollModule
    RollModule -->|Enforces limits, caps, deadline & strike| ChainlinkFeeds
    RollModule -->|safe.execTransactionFromModule(OptionBook, fillOrder)| UserSafe
    UserSafe -->|Spends USDC & receives option position| OptionBook
```

### 11.2 Tech Stack Breakdown by Layer

| Layer | Technologies & Dependencies | Purpose & Invariant Boundary |
|---|---|---|
| **Smart Contracts** | Solidity (`^0.8.28`), Foundry (`forge`), `ISafe` / Safe Module standard | Implements `PayungRollModule.sol`. Stores commitments, enforces spend/roll caps, verifies 4-byte selector (`0x11be7f27`), checks Chainlink strike tolerances, and invokes `ISafe.execTransactionFromModule`. Real user funds remain in the Safe. |
| **Smart Account** | Safe (v1.3.0 / v1.4.1), `@safe-global/protocol-kit` (`^8.0.6`) | User owns 1-owner Safe. Deployed deterministically (`predictSafeAddress`). Receives options; Safe is the on-chain buyer of record. |
| **Keeper Network** | Gelato Web3 Functions (`@gelatonetwork/web3-functions-sdk`, `@gelatonetwork/automate-sdk`) | Decentralized off-chain execution trigger. `gelato/resolver.ts` checks event logs + calls `/api/precise/next-roll`; `gelato/register.ts` configures task. Permissionless fallback. |
| **Backend & APIs** | Next.js 15 App Router, Node.js 18+, TypeScript | Serves stateless API routes (`/api/precise/*`). Formats unsigned calldata for user and keeper; merges positions with on-chain commitments (`src/precise.ts`). Never server-signs. |
| **Protocol Integration** | `@thetanuts-finance/thetanuts-client` (`^0.3.0`), `ethers` (`^6.13.0`) | Exclusively isolated in `src/core.ts`. Reads orderbook, derives quotes, and generates `encodeFillOrder` calldata for rolls. |
| **Price Feeds** | Chainlink AggregatorV3 (`ETH/USD`, `BTC/USD` on Base) | On-chain tolerance verification in contract; live spot price in web and evaluation pipeline. |
| **Frontend UI** | React 19, CSS Modules, Next.js App Router | Onboarding flow (`app/protect/precise-setup/page.tsx`), results screen CTA (`app/protect/results/page.tsx`), and portfolio management/cancel (`app/my-protection/page.tsx`). |
| **Testing & Quality** | Foundry (`forge test`), Vitest (`^4.1.11`), TypeScript (`tsc --noEmit`) | Multi-tier test suite: 16 Foundry tests for contract logic/reverts, 229 Vitest tests for off-chain math and domain logic, zero-network unit tests. |

### 11.3 Transaction & Data Flow

1. **Setup Flow (User-Driven)**
   - User inputs budget on `/protect/precise-setup`.
   - Client calls `deployOrConnectSafe()` via Safe SDK.
   - Client funds Safe with USDC (`fundSafe`).
   - Server computes `open(Commitment)` calldata via `/api/precise/prepare-open`.
   - Client executes bundled Safe multisend transaction: `enableModule(PayungRollModule)` + `module.open(...)`.
   - Module emits `CommitmentOpened(safe, ...)`.

2. **Roll Execution Flow (Automated Keeper)**
   - Gelato Web3 Function runner queries `CommitmentOpened` events to list active Safes.
   - Resolver calls `GET /api/precise/next-roll?safe=...`.
   - Backend checks `commitments(safe)`, verifies if current leg has `<= 2` days to expiry, finds candidate order via Thetanuts SDK, quotes price, and returns `{ due: true, fillOrderCalldata, usdcAmount, orderStrike, orderExpiry }`.
   - Gelato triggers `PayungRollModule.executeRoll(...)`.
   - Module validates deadline, spend caps, strike range via Chainlink, and selector (`0x11be7f27`), then calls `safe.execTransactionFromModule(...)`.
   - OptionBook debits USDC from the Safe and transfers the put option token to the Safe.

3. **Cancellation Flow (Self-Sovereign User-Driven)**
   - User clicks "Cancel protection" in `/my-protection`.
   - Client calls `/api/precise/prepare-cancel` to get unsigned `cancel()` calldata.
   - User's connected wallet signs the transaction to `PayungRollModule.cancel()`.
   - Module validates `msg.sender == commitment.safe` and sets `active = false`.
   - No future rolls can occur; active put leg continues to expiry.
