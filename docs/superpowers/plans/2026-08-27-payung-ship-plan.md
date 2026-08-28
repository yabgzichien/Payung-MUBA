# Payung — Hardening & Ship Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the verified Thetanuts execution core from "works in one happy path" to a submittable two-track hackathon product: fix the two correctness bugs the audit found, add the Aave collateral helper, the NL intent parser, the deterministic judgment layer, a thin HTTP API, a live web UI, honest docs, and a demo runbook.

**Architecture:** One core (`src/core.ts`) is the only module that touches Thetanuts. Pure, unit-testable functions (filtering, decoding, capping, judgment, intent validation) are separated from live-network wrappers so almost everything is testable without mainnet. One web app serves both tracks: the NL agent is the front door (Track 02), the floor-picker/payoff body is the product (Track 01). The LLM (Gonka Router) only parses intent — it never produces a number.

**Tech Stack:** TypeScript (ESM), ethers v6, `@thetanuts-finance/thetanuts-client` 0.3.x, tsx, vitest (new), plain `node:http` server (no framework), vanilla-JS web page (already styled in `web/index.html`), Gonka Router (OpenAI-compatible chat completions).

**Spec:** [Payung_Spec.md](../../../Payung_Spec.md) — this plan implements FR1–FR9 and the edge-case table. **Audit:** [FableAudit.md](../../../FableAudit.md) — Tasks 1–5 and 10 are the audit's Attacks 1–5 fixes; Task 7 is Attack 6; Task 11 is Attacks 7–8.

## Global Constraints

- **Base mainnet only, chainId 8453.** No testnet exists in the SDK config; Track 02 explicitly disqualifies testnet/paper trades.
- **No fabricated numbers, anywhere.** Every price/premium/payoff figure traces to `fetchOrders()`, `previewFillOrder()`, or receipt logs. The LLM never outputs a number that reaches the UI.
- **Burner wallet only**, funded ~$20 USDC + cents of ETH gas. `PRIVATE_KEY` lives in gitignored `.env` only. Check git history before submitting.
- **Approve exact amounts**, never `MaxUint256` (already true in `execute()` — keep it that way).
- **Fail loud, fail cheap.** Everything before user confirmation must cost $0: `callStaticFillOrder()` before every real send; empty candidate list is a valid, honest answer (FR9).
- **Real trades can be tiny.** Per the builder docs, a ~1 USDC fill scores the same as $100. Default demo size: $10.
- **Paid RPC for the demo.** `BASE_RPC_URL` should be a free Alchemy/Infura key, not `mainnet.base.org` (rate-limited).
- **Vitest tests never touch the network.** Live verification happens through named CLI smoke commands, marked "requires network" in each task.
- ESM project (`"type": "module"`): intra-project imports use the `.js` suffix (e.g. `./core.js`), matching the existing convention.

## File Structure

| File | Responsibility |
|---|---|
| `src/core.ts` (modify) | Only module touching Thetanuts. Gains pure `decodeOrder`, `filterCandidates`, `capSpend`, `assertFillable`, `coverageGapDays`, `sumDebits`; async wrappers stay thin. |
| `src/aave.ts` (create) | USDC → aBasUSDC deposit: pure `planDeposit` + live `ensureDollarCollateral`. |
| `src/intent.ts` (create) | NL → `ProtectionSpec`: `gonkaLlm()` transport + `parseIntent()` validation. |
| `src/judgment.ts` (create) | Deterministic agent judgment: `judgeQuote()` — premium-vs-value verdict, coverage-gap honesty. No LLM. |
| `src/server.ts` (create) | `node:http` JSON API over core + static file serving of `web/`. |
| `src/cli.ts` (modify) | Adds `ask`, `deposit`, `preflight` commands; honest max-loss copy; coverage warnings. |
| `web/index.html` (modify) | Replace mock data path with real API calls; add NL front door; judgment + coverage display. |
| `tests/fixtures.ts` (create) | `makeCandidate()` factory + fake token/feed addresses. |
| `tests/*.test.ts` (create) | Pure-function tests: decode, filter, fill-safety, coverage, aave-plan, intent, judgment, wire. |
| `PROJECT.md`, `README.md`, `docs/demo-runbook.md` | Honest docs + submission + demo ops. |

---

### Task 1: Repo init, test infra, and pure order decoding (fixes budget decimals, exposes `priceFeed`)

The project is not a git repo yet (audit Attack 7) and has no test runner. This task sets both up, then extracts the order-decoding logic in `getBook()` into a pure function — fixing a latent bug (maker budget is decoded with USDC decimals even for WETH/cbBTC orders) and adding the `priceFeed` field that Task 2's asset filter needs.

**Files:**
- Create: `.git` (via `git init`), `tests/fixtures.ts`, `tests/decode.test.ts`
- Modify: `package.json` (add vitest + test script), `src/core.ts:43-111` (Candidate type + getBook)

**Interfaces:**
- Consumes: existing `Candidate`, `getBook`, `collateralDecimals`, `STRIKE_DECIMALS` in `src/core.ts`.
- Produces: `decodeOrder(o: any, scale: number, nowSec: number, collateralDec: number): Candidate` (pure, exported); `Candidate` gains `priceFeed: string` (lowercase) and renames `makerBudgetUsdc` → `makerBudget` (number, in the order's own collateral-token units). Later tasks import `decodeOrder`, `makeCandidate`, and the fixture addresses.

- [ ] **Step 1: Initialize the repo and commit the existing state**

```bash
cd /home/yang/Project/MUBA
git init -b main
git add -A
git status   # VERIFY: .env and node_modules are NOT staged (.gitignore must cover both; if .env appears, stop and fix .gitignore first)
git commit -m "chore: initial commit — verified Thetanuts execution core, CLI, spec, audit"
```

- [ ] **Step 2: Install vitest and add the test script**

```bash
npm install -D vitest
```

In `package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 3: Write the fixtures module**

Create `tests/fixtures.ts`:

```ts
import type { Candidate } from '../src/core.js';

// Fake but valid-shaped addresses. Tests never touch the network.
export const FEED_ETH = '0x00000000000000000000000000000000000000e1';
export const FEED_BTC = '0x00000000000000000000000000000000000000b1';
export const USDC = '0x00000000000000000000000000000000000000c1';
export const ABAS_USDC = '0x00000000000000000000000000000000000000a1';
export const WETH = '0x00000000000000000000000000000000000000f1';

export function makeCandidate(over: Partial<Candidate> = {}): Candidate {
  return {
    raw: { signature: '0xs1gdefault0000000000' },
    isCall: false,
    makerIsBuyer: false,
    yourSide: 'you buy the option',
    strike: 2300,
    expiry: new Date('2026-09-10T08:00:00Z'),
    daysToExpiry: 14,
    pricePerContract: 19.94,
    collateralToken: ABAS_USDC,
    priceFeed: FEED_ETH,
    makerBudget: 5000,
    greeks: { iv: 0.55 },
    ...over,
  };
}
```

(This will not typecheck until Step 5 adds `priceFeed`/`makerBudget` to `Candidate` — that's expected; the failing test comes first.)

- [ ] **Step 4: Write the failing decode test**

Create `tests/decode.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeOrder } from '../src/core.js';
import { ABAS_USDC, FEED_ETH } from './fixtures.js';

const NOW = 1_788_000_000; // fixed "now" in unix seconds

function rawOrder(over: any = {}) {
  return {
    order: {
      expiry: String(NOW + 14 * 86400),
      isBuyer: false,
      strikePrice: '230000000000', // 1e8 scale -> $2300
      price: '1994000000',         // scale 1e8 -> $19.94
      collateralToken: ABAS_USDC,
      ...over.order,
    },
    availableAmount: 5_000_000_000n, // 5000 with 6 decimals
    signature: '0xabc',
    rawApiData: { isCall: false, priceFeed: FEED_ETH.toUpperCase(), greeks: { iv: 0.55 } },
    ...over,
  };
}

describe('decodeOrder', () => {
  it('decodes strike, price, expiry, side and budget', () => {
    const c = decodeOrder(rawOrder(), 1e8, NOW, 6);
    expect(c.strike).toBe(2300);
    expect(c.pricePerContract).toBeCloseTo(19.94);
    expect(c.daysToExpiry).toBeCloseTo(14);
    expect(c.makerIsBuyer).toBe(false);
    expect(c.yourSide).toBe('you buy the option');
    expect(c.makerBudget).toBe(5000);
  });

  it('uses the collateral token own decimals for maker budget (18-dec token)', () => {
    const o = rawOrder({ availableAmount: 2_000_000_000_000_000_000n }); // 2.0 with 18 decimals
    const c = decodeOrder(o, 1e8, NOW, 18);
    expect(c.makerBudget).toBe(2);
  });

  it('lowercases the price feed', () => {
    const c = decodeOrder(rawOrder(), 1e8, NOW, 6);
    expect(c.priceFeed).toBe(FEED_ETH); // fixture is already lowercase
  });

  it('marks maker-is-buyer orders as you-sell', () => {
    const c = decodeOrder(rawOrder({ order: { isBuyer: true } }), 1e8, NOW, 6);
    expect(c.yourSide).toBe('you sell the option');
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run tests/decode.test.ts`
Expected: FAIL — `decodeOrder` is not exported from `../src/core.js`.

- [ ] **Step 6: Implement `decodeOrder` and rewire `getBook`**

In `src/core.ts`, change the `Candidate` type: add `priceFeed`, rename `makerBudgetUsdc` → `makerBudget` (nothing outside core references the old name — verified):

```ts
export type Candidate = {
  raw: any;
  isCall: boolean;
  /** True if the MAKER is the buyer — which means YOU, the taker, are the seller. */
  makerIsBuyer: boolean;
  /** Plain-English side, computed once so the UI never has to reason about it. */
  yourSide: 'you buy the option' | 'you sell the option';
  strike: number;
  expiry: Date;
  daysToExpiry: number;
  /** Premium per contract, in USDC. Decoded with the contract's real price decimals. */
  pricePerContract: number;
  /** Collateral token for THIS order — the book quotes USDC, aBasUSDC, WETH and cbBTC. */
  collateralToken: string;
  /** Chainlink feed for the order's UNDERLYING (lowercase) — this is how we know ETH vs BTC. */
  priceFeed: string;
  /** How much this maker can still absorb, in the order's own collateral-token units. */
  makerBudget: number;
  greeks: { delta?: number; iv?: number; gamma?: number; theta?: number; vega?: number };
};
```

Then replace the body of `getBook` with a pure decode + thin async wrapper:

```ts
/** Pure decode of one raw SDK order. Exported for tests — no network, no Date.now(). */
export function decodeOrder(o: any, scale: number, nowSec: number, collateralDec: number): Candidate {
  const expirySec = Number(o.order.expiry);
  const makerIsBuyer = Boolean(o.order.isBuyer);
  return {
    raw: o,
    isCall: Boolean(o.rawApiData?.isCall),
    makerIsBuyer,
    // If the maker is buying, you are on the other side: you sell.
    yourSide: makerIsBuyer ? 'you sell the option' : 'you buy the option',
    strike: Number(o.order.strikePrice) / 10 ** STRIKE_DECIMALS,
    expiry: new Date(expirySec * 1000),
    daysToExpiry: (expirySec - nowSec) / 86400,
    pricePerContract: Number(o.order.price) / scale,
    collateralToken: o.order.collateralToken,
    priceFeed: String(o.rawApiData?.priceFeed ?? '').toLowerCase(),
    makerBudget: Number(o.availableAmount) / 10 ** collateralDec,
    greeks: o.rawApiData?.greeks ?? {},
  };
}

/** Every live, funded, unexpired order on Base, decoded into something a UI can render. */
export async function getBook(client = readClient()): Promise<Candidate[]> {
  const orders: any[] = await client.api.fetchOrders();
  const scale = await priceScale(client);
  const now = Math.floor(Date.now() / 1000);
  const live = orders.filter(
    (o) => Number(o.order?.expiry ?? 0) > now && BigInt(o.availableAmount ?? 0) > 0n
  );
  const decs = new Map<string, number>();
  for (const o of live) {
    const t = String(o.order.collateralToken).toLowerCase();
    if (!decs.has(t)) decs.set(t, await collateralDecimals(client, o.order.collateralToken));
  }
  return live.map((o) =>
    decodeOrder(o, scale, now, decs.get(String(o.order.collateralToken).toLowerCase())!)
  );
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/decode.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Live smoke check (requires network)**

Run: `npm run book`
Expected: same output shape as before (N live orders, first 15 shown). This confirms the async decimals preload didn't break the live path.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tests/ src/core.ts
git commit -m "feat: pure decodeOrder with per-token budget decimals and priceFeed; vitest infra"
```

---

### Task 2: Fix the two filter bugs — dollar collateral (Audit Attack 1) and underlying asset (Audit Attack 2)

`findCandidates()` currently (a) filters to **raw USDC** collateral while PROJECT.md's own confirmed fact says buyable puts settle in **aBasUSDC** — meaning it may return zero candidates for every query — and (b) never checks the underlying asset, so a SOL put can be sold as ETH protection. This task extracts the filter into a pure function, fixes both, and empirically records which collateral the live book actually quotes.

**Files:**
- Create: `tests/filter.test.ts`
- Modify: `src/core.ts:129-154` (`findCandidates`)

**Interfaces:**
- Consumes: `Candidate` (with `priceFeed`, from Task 1), `ProtectionSpec`, `getBook`, `client.erc20.getSymbol`, `client.chainConfig.priceFeeds`.
- Produces:
  - `type FilterConfig = { dollarTokens: Set<string>; assetPriceFeed: string }`
  - `filterCandidates(book: Candidate[], spec: ProtectionSpec, cfg: FilterConfig): Candidate[]` (pure)
  - `tokenSymbol(client: ThetanutsClient, token: string): Promise<string>` (cached)
  - `dollarTokens(client: ThetanutsClient, book: Candidate[]): Promise<Set<string>>`
  - `findCandidates(spec, client?)` keeps its existing signature — later tasks and the CLI call it unchanged.

- [ ] **Step 1: Write the failing filter tests**

Create `tests/filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterCandidates, type FilterConfig } from '../src/core.js';
import { makeCandidate, USDC, ABAS_USDC, WETH, FEED_ETH, FEED_BTC } from './fixtures.js';

const spec = { asset: 'ETH' as const, floorUsd: 2300, horizonDays: 14 };
const cfg: FilterConfig = { dollarTokens: new Set([USDC, ABAS_USDC]), assetPriceFeed: FEED_ETH };

describe('filterCandidates', () => {
  it('accepts aBasUSDC-collateralized buyable puts (Audit Attack 1)', () => {
    const book = [makeCandidate({ collateralToken: ABAS_USDC })];
    expect(filterCandidates(book, spec, cfg)).toHaveLength(1);
  });

  it('accepts raw-USDC collateral too', () => {
    const book = [makeCandidate({ collateralToken: USDC })];
    expect(filterCandidates(book, spec, cfg)).toHaveLength(1);
  });

  it('rejects non-dollar collateral (WETH)', () => {
    const book = [makeCandidate({ collateralToken: WETH })];
    expect(filterCandidates(book, spec, cfg)).toHaveLength(0);
  });

  it('rejects a different underlying even at a nearby strike (Audit Attack 2)', () => {
    const book = [makeCandidate({ priceFeed: FEED_BTC, strike: 2200 })];
    expect(filterCandidates(book, spec, cfg)).toHaveLength(0);
  });

  it('rejects calls and maker-is-buyer orders', () => {
    const book = [
      makeCandidate({ isCall: true }),
      makeCandidate({ makerIsBuyer: true, yourSide: 'you sell the option' }),
    ];
    expect(filterCandidates(book, spec, cfg)).toHaveLength(0);
  });

  it('keeps the 0.6x-2.5x horizon window and ranks by strike distance', () => {
    const book = [
      makeCandidate({ strike: 2100, daysToExpiry: 10 }),
      makeCandidate({ strike: 2290, daysToExpiry: 10 }),
      makeCandidate({ strike: 2290, daysToExpiry: 5 }),  // 5 < 14*0.6 -> out
      makeCandidate({ strike: 2290, daysToExpiry: 40 }), // 40 > 14*2.5 -> out
    ];
    const out = filterCandidates(book, spec, cfg);
    expect(out).toHaveLength(2);
    expect(out[0].strike).toBe(2290); // closest to 2300 first
  });

  it('returns at most 8 candidates', () => {
    const book = Array.from({ length: 12 }, (_, i) => makeCandidate({ strike: 2000 + i * 10 }));
    expect(filterCandidates(book, spec, cfg)).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/filter.test.ts`
Expected: FAIL — `filterCandidates` not exported.

- [ ] **Step 3: Implement the pure filter and rewire `findCandidates`**

In `src/core.ts`, replace the whole `findCandidates` block with:

```ts
export type FilterConfig = {
  /** Lowercase collateral-token addresses treated as dollar-denominated (USDC, aBasUSDC). */
  dollarTokens: Set<string>;
  /** Lowercase Chainlink feed address for the spec's underlying asset. */
  assetPriceFeed: string;
};

/**
 * Pure filter over an already-decoded book. Exported for tests.
 *
 * This is the function whose integrity is the whole pitch. It does NOT invent
 * anything — if it returns [], there is genuinely nothing fillable that
 * matches, and the agent must say so rather than improvise (FR9).
 */
export function filterCandidates(
  book: Candidate[],
  spec: ProtectionSpec,
  cfg: FilterConfig
): Candidate[] {
  return (
    book
      // A floor under a long asset position is a PUT — the correct instrument,
      // not a judgement call or a prediction.
      .filter((c) => !c.isCall)
      // CRITICAL: to BUY protection you need a maker who is SELLING. Only ~20%
      // of the book qualifies. Without this you'd be writing naked puts.
      .filter((c) => !c.makerIsBuyer)
      // CRITICAL: protection must be on the asset the user actually holds.
      // The book is multi-asset; strike distance is NOT a proxy for underlying.
      .filter((c) => c.priceFeed === cfg.assetPriceFeed)
      // Dollar-denominated collateral only, so premiums are in dollars. The live
      // book quotes buyable puts in aBasUSDC (Aave-wrapped USDC), not raw USDC.
      .filter((c) => cfg.dollarTokens.has(c.collateralToken.toLowerCase()))
      .filter((c) => c.daysToExpiry >= spec.horizonDays * 0.6)
      .filter((c) => c.daysToExpiry <= spec.horizonDays * 2.5)
      // Prefer strikes near the requested floor.
      .sort((a, b) => Math.abs(a.strike - spec.floorUsd) - Math.abs(b.strike - spec.floorUsd))
      .slice(0, 8)
  );
}

/** ERC20 symbol, cached per token address. */
const _symCache = new Map<string, string>();
export async function tokenSymbol(client: ThetanutsClient, token: string): Promise<string> {
  const key = token.toLowerCase();
  if (!_symCache.has(key)) {
    _symCache.set(key, await client.erc20.getSymbol(token));
  }
  return _symCache.get(key)!;
}

/**
 * Which collateral tokens in this book are dollar-denominated?
 * Discovered from the live book by symbol (USDC, aBasUSDC), never hardcoded —
 * the book has changed its quoting token before and can again.
 */
export async function dollarTokens(
  client: ThetanutsClient,
  book: Candidate[]
): Promise<Set<string>> {
  const distinct = [...new Set(book.map((c) => c.collateralToken.toLowerCase()))];
  const out = new Set<string>();
  for (const t of distinct) {
    const sym = await tokenSymbol(client, t);
    if (sym.toUpperCase().endsWith('USDC')) out.add(t);
  }
  return out;
}

/**
 * Translate a human constraint into candidate structures, against the live book.
 * Thin wrapper: gathers live inputs, then delegates to the pure filter above.
 */
export async function findCandidates(
  spec: ProtectionSpec,
  client = readClient()
): Promise<Candidate[]> {
  const book = await getBook(client);
  const feed = client.chainConfig.priceFeeds[spec.asset];
  if (!feed) {
    throw new Error(
      `No price feed configured for ${spec.asset}. Known: ${Object.keys(client.chainConfig.priceFeeds).join(', ')}`
    );
  }
  return filterCandidates(book, spec, {
    dollarTokens: await dollarTokens(client, book),
    assetPriceFeed: feed.toLowerCase(),
  });
}
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS (decode + filter suites).

- [ ] **Step 5: Live verification of both fixes (requires network)**

Write a throwaway check — add nothing to the repo; run it inline:

```bash
npx tsx -e "
import { readClient, getBook, findCandidates, dollarTokens } from './src/core.js';
const client = readClient();
const book = await getBook(client);
console.log('priceFeeds config:', client.chainConfig.priceFeeds);
console.log('distinct feeds in book:', [...new Set(book.map(c => c.priceFeed))]);
const dollars = await dollarTokens(client, book);
console.log('dollar collateral tokens:', [...dollars]);
const buyablePuts = book.filter(c => !c.isCall && !c.makerIsBuyer);
console.log('buyable-put collateral tokens:', [...new Set(buyablePuts.map(c => c.collateralToken))]);
const cands = await findCandidates({ asset: 'ETH', floorUsd: 2300, horizonDays: 14 });
console.log('ETH \$2300/14d candidates:', cands.length, cands.map(c => ({ s: c.strike, d: c.daysToExpiry.toFixed(1) })));
"
```

Expected: `candidates` is **non-zero** (this was the audit's demo-killer), the ETH feed in config matches feeds seen in the book, and the buyable-put collateral list shows what the book actually quotes today. **Record the observed collateral answer** — Task 10 updates PROJECT.md line 169 to match it. If candidates is still 0, inspect the printed feeds/tokens before proceeding: the mismatch will be visible in this output (wrong feed key name or an unexpected collateral symbol) — fix `findCandidates`'s feed lookup or the `dollarTokens` predicate accordingly, and note what changed.

- [ ] **Step 6: Commit**

```bash
git add src/core.ts tests/filter.test.ts
git commit -m "fix: accept aBasUSDC collateral and filter by underlying asset (audit attacks 1+2)"
```

---

### Task 3: Fill safety — budget capping, staleness guard, and the honest max-loss number (Audit Attack 3 + spec edge cases)

Three spec edge-cases live here: cap the fill to the maker's `availableAmount` (visibly, never silently), re-check order expiry immediately before execution, and stop asserting an unverified max-loss claim. The honest, always-true statement for a *bought* put is: **your max loss is what leaves your wallet today** — and we read that number from the fill receipt's Transfer logs instead of asserting it.

**Files:**
- Create: `tests/fill-safety.test.ts`
- Modify: `src/core.ts` (`Quote` type, `quote()`, `execute()`, new pure helpers), `src/cli.ts:74-104` (quote/execute output copy)

**Interfaces:**
- Consumes: `Candidate.makerBudget` (Task 1), `simulate`, `ethers` (already imported in core).
- Produces (all exported from `src/core.ts`):
  - `capSpend(requestedUsdc: number, makerBudget: number): { spendUsdc: number; capped: boolean }`
  - `assertFillable(c: Candidate, nowSec: number, bufferSec?: number): void` (throws with a re-quote message)
  - `sumDebits(logs: Array<{ address: string; topics: string[]; data: string }>, token: string, from: string): bigint`
  - `Quote` gains `requestedUsdc: number`, `spendUsdc: number`, `capped: boolean`
  - `quote(candidate, requestedUsdc, client?)` — same call shape, second param now means "requested spend, may be capped"
  - `execute(candidate, spendUsdc, client?)` returns `{ hash, explorer, receipt, paidUnits: bigint, paidUsd: number }`

- [ ] **Step 1: Write the failing tests**

Create `tests/fill-safety.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { capSpend, assertFillable, sumDebits } from '../src/core.js';
import { makeCandidate, ABAS_USDC } from './fixtures.js';

describe('capSpend', () => {
  it('passes through when maker budget suffices', () => {
    expect(capSpend(10, 5000)).toEqual({ spendUsdc: 10, capped: false });
  });
  it('caps to the maker budget and says so', () => {
    expect(capSpend(10, 7.5)).toEqual({ spendUsdc: 7.5, capped: true });
  });
});

describe('assertFillable', () => {
  const c = makeCandidate({ expiry: new Date('2026-09-10T08:00:00Z') });
  const expirySec = Math.floor(c.expiry.getTime() / 1000);
  it('accepts an order with time left', () => {
    expect(() => assertFillable(c, expirySec - 3600)).not.toThrow();
  });
  it('rejects an order inside the buffer, telling the user to re-quote', () => {
    expect(() => assertFillable(c, expirySec - 30)).toThrow(/re-quote/i);
  });
});

describe('sumDebits', () => {
  const ME = '0x1111111111111111111111111111111111111111';
  const OTHER = '0x2222222222222222222222222222222222222222';
  const TRANSFER = ethers.id('Transfer(address,address,uint256)');
  const pad = (a: string) => ethers.zeroPadValue(a, 32);
  const log = (token: string, from: string, amount: bigint) => ({
    address: token,
    topics: [TRANSFER, pad(from), pad(OTHER)],
    data: ethers.toBeHex(amount, 32),
  });

  it('sums transfers out of my address on the collateral token only', () => {
    const logs = [
      log(ABAS_USDC, ME, 7_000_000n),
      log(ABAS_USDC, ME, 3_000_000n),
      log(ABAS_USDC, OTHER, 99_000_000n),          // not from me
      log('0x00000000000000000000000000000000000000f1', ME, 5n), // wrong token
    ];
    expect(sumDebits(logs, ABAS_USDC, ME)).toBe(10_000_000n);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fill-safety.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the helpers and rewire `quote`/`execute`**

In `src/core.ts`, add above the `Quote` type:

```ts
/** Cap a requested spend to what the maker can still absorb. Never silent: the flag travels to the UI. */
export function capSpend(
  requestedUsdc: number,
  makerBudget: number
): { spendUsdc: number; capped: boolean } {
  if (requestedUsdc <= makerBudget) return { spendUsdc: requestedUsdc, capped: false };
  return { spendUsdc: makerBudget, capped: true };
}

/** Refuse to send against an order that expires within the buffer. The fix is a fresh quote, so say so. */
export function assertFillable(c: Candidate, nowSec: number, bufferSec = 60): void {
  const expirySec = Math.floor(c.expiry.getTime() / 1000);
  if (expirySec <= nowSec + bufferSec) {
    throw new Error(
      `Order expires at ${c.expiry.toISOString()} — too close to send safely. Re-quote and pick a fresh candidate.`
    );
  }
}

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

/** Sum ERC20 Transfer amounts OUT of `from` on `token`, from receipt logs. This is the empirical "what you actually paid". */
export function sumDebits(
  logs: Array<{ address: string; topics: string[]; data: string }>,
  token: string,
  from: string
): bigint {
  const fromTopic = ethers.zeroPadValue(from, 32).toLowerCase();
  return logs
    .filter((l) => l.address.toLowerCase() === token.toLowerCase())
    .filter((l) => l.topics?.[0] === TRANSFER_TOPIC && l.topics?.[1]?.toLowerCase() === fromTopic)
    .reduce((acc, l) => acc + BigInt(l.data), 0n);
}
```

Update the `Quote` type and `quote()`:

```ts
export type Quote = {
  /** What the user asked to spend. */
  requestedUsdc: number;
  /** What will actually be sent as the fill amount (capped to maker budget). */
  spendUsdc: number;
  capped: boolean;
  collateralUsdc: number;
  numContracts: string;
  maxContracts: string;
  pricePerContract: number;
  /** What you actually pay or receive, in USDC. */
  premiumUsdc: number;
  strike: number;
  expiry: Date;
  yourSide: Candidate['yourSide'];
  preview: any;
};

export async function quote(
  candidate: Candidate,
  requestedUsdc: number,
  client = readClient()
): Promise<Quote> {
  const { spendUsdc, capped } = capSpend(requestedUsdc, candidate.makerBudget);
  const amount = BigInt(Math.round(spendUsdc * 10 ** USDC_DECIMALS));
  const preview: any = client.optionBook.previewFillOrder(candidate.raw, amount);
  const scale = await priceScale(client);

  const pricePerContract = Number(preview.pricePerContract) / scale;
  // numContracts is scaled such that, for a cash-secured put,
  // collateral ≈ strike × contracts. Derive contracts from that identity
  // rather than assuming a decimal count.
  const contracts = Number(preview.totalCollateral) / 10 ** USDC_DECIMALS / candidate.strike;

  return {
    requestedUsdc,
    spendUsdc,
    capped,
    collateralUsdc: Number(preview.totalCollateral) / 10 ** USDC_DECIMALS,
    numContracts: String(preview.numContracts),
    maxContracts: String(preview.maxContracts),
    pricePerContract,
    premiumUsdc: pricePerContract * contracts,
    strike: candidate.strike,
    expiry: candidate.expiry,
    yourSide: candidate.yourSide,
    preview,
  };
}
```

Update `execute()`:

```ts
export async function execute(
  candidate: Candidate,
  spendUsdc: number,
  client = writeClient()
): Promise<{ hash: string; explorer: string; receipt: any; paidUnits: bigint; paidUsd: number }> {
  const amount = BigInt(Math.round(spendUsdc * 10 ** USDC_DECIMALS));

  // Spec edge case: the order can expire between quoting and confirming.
  assertFillable(candidate, Math.floor(Date.now() / 1000));

  // Fail loudly before spending gas if the fill would revert.
  const sim = await simulate(candidate, spendUsdc, client);
  if (!sim.ok) throw new Error(`Simulation failed, refusing to send: ${sim.error}`);

  // Approve THIS order's collateral token, not a hardcoded USDC address.
  await client.erc20.ensureAllowance(
    candidate.collateralToken,
    client.chainConfig.contracts.optionBook,
    amount
  );

  const receipt: any = await client.optionBook.fillOrder(candidate.raw, amount);
  const rec = receipt?.receipt ?? receipt;
  const hash = rec?.hash ?? rec?.transactionHash ?? String(receipt);

  // The empirical answer to "who posts what": read what actually left the wallet.
  const me = await client.getSignerAddress();
  const dec = await collateralDecimals(client, candidate.collateralToken);
  const paidUnits = sumDebits(rec?.logs ?? [], candidate.collateralToken, me);
  return {
    hash,
    explorer: `https://basescan.org/tx/${hash}`,
    receipt,
    paidUnits,
    paidUsd: Number(paidUnits) / 10 ** dec,
  };
}
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Fix the CLI copy (kills the unverified max-loss claim)**

In `src/cli.ts`, replace the quote-output block (currently the lines printing `collateral … <- posted upfront by you` through `^ VERIFY THIS…`):

```ts
      console.log(`\n── Quote ────────────────────────────────`);
      console.log(`side          ${q.yourSide.toUpperCase()}`);
      console.log(`strike        ${usd(q.strike)}`);
      console.log(`expiry        ${q.expiry.toISOString().slice(0, 16).replace('T', ' ')}`);
      if (q.capped) {
        console.log(`you spend     ${usd(q.spendUsdc)}  (capped — maker can only absorb ${usd(q.spendUsdc)} of your requested ${usd(q.requestedUsdc)})`);
      } else {
        console.log(`you spend     ${usd(q.spendUsdc)}`);
      }
      console.log(`premium       ${usd(q.premiumUsdc)}`);
      console.log(`contracts     ${q.numContracts} (raw)`);

      const curve = payoffCurve(q, [q.strike * 0.85, q.strike * 1.15], 6);
      console.log(`\npayoff:`);
      curve.forEach((p) => console.log(`  spot ${usd(p.spot).padEnd(10)} pnl ${usd(p.pnl)}`));

      console.log(`\nMAX LOSS (you buy): what leaves your wallet today, and nothing more —`);
      console.log(`the exact debit is read from the fill receipt's Transfer logs on execute.\n`);
```

And in the execute branch, after `const res = await execute(pick, collateral);` replace the two log lines with:

```ts
      console.log(`\n  tx    ${res.hash}`);
      console.log(`  paid  ${usd(res.paidUsd)}  <- read from Transfer logs; this is the max-loss number to say on stage`);
      console.log(`  ->    ${res.explorer}\n`);
      console.log('Put that URL on screen during the pitch.\n');
```

- [ ] **Step 6: Live smoke check (requires network, read-only)**

Run: `npm run quote -- 2300 10`
Expected: candidates print, quote shows `you spend $10.00` (or a capped line if the top maker is nearly drained), and the new max-loss copy. No unverified "collateral posted by you" claim anywhere.

- [ ] **Step 7: Commit**

```bash
git add src/core.ts src/cli.ts tests/fill-safety.test.ts
git commit -m "feat: budget capping, staleness guard, receipt-derived paid amount (audit attack 3 + spec edge cases)"
```

---

### Task 4: Coverage-gap honesty (Audit Attack 4)

The filter accepts expiries from 0.6× the requested horizon, so "protect me for 14 days" can return a 9-day put. That's allowed — but it must be loud, never silent: the audit calls the honesty fix mandatory.

**Files:**
- Create: `tests/coverage.test.ts`
- Modify: `src/core.ts` (one pure function), `src/cli.ts` (candidate display + quote warning)

**Interfaces:**
- Consumes: `Candidate.daysToExpiry`, `ProtectionSpec.horizonDays`.
- Produces: `coverageGapDays(c: Candidate, spec: ProtectionSpec): number` exported from `src/core.ts` — used by CLI here, by the judgment layer (Task 7) and the server (Task 8).

- [ ] **Step 1: Write the failing test**

Create `tests/coverage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { coverageGapDays } from '../src/core.js';
import { makeCandidate } from './fixtures.js';

const spec = { asset: 'ETH' as const, floorUsd: 2300, horizonDays: 14 };

describe('coverageGapDays', () => {
  it('is zero when the option outlives the horizon', () => {
    expect(coverageGapDays(makeCandidate({ daysToExpiry: 21 }), spec)).toBe(0);
  });
  it('is the shortfall when the option ends early', () => {
    expect(coverageGapDays(makeCandidate({ daysToExpiry: 8.7 }), spec)).toBeCloseTo(5.3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/coverage.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `src/core.ts` (near `filterCandidates`):

```ts
/**
 * How many days short of the user's stated deadline this option's protection
 * ends. > 0 means the floor evaporates BEFORE the date the user asked for —
 * allowed, but it must be surfaced loudly, never silently (FR/audit attack 4).
 */
export function coverageGapDays(c: Candidate, spec: ProtectionSpec): number {
  return Math.max(0, spec.horizonDays - c.daysToExpiry);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Surface it in the CLI**

In `src/cli.ts`, inside the `quote`/`simulate`/`execute` case, after `const pick = candidates[0];` add:

```ts
      const gap = coverageGapDays(pick, { asset: 'ETH', floorUsd, horizonDays: 7 });
      if (gap > 0.25) {
        console.log(
          `\n⚠ COVERAGE GAP: this floor ends ${pick.expiry.toISOString().slice(0, 10)} — ` +
          `${gap.toFixed(1)} days BEFORE your stated deadline. After that date you are unprotected.`
        );
      }
```

(Add `coverageGapDays` to the import list from `./core.js`. The hardcoded `horizonDays: 7` mirrors the existing hardcoded spec in this case block — both come from the same object; hoist it to a `const spec = { asset: 'ETH', floorUsd, horizonDays: 7 } as const;` used by both the `findCandidates` call and this line.)

- [ ] **Step 6: Commit**

```bash
git add src/core.ts src/cli.ts tests/coverage.test.ts
git commit -m "feat: loud coverage-gap warning when protection ends before the stated deadline (audit attack 4)"
```

---

### Task 5: Aave deposit helper — the unticked TODO on the critical path (Audit Attack 1, second half)

Buyable puts settle in aBasUSDC; the burner wallet holds raw USDC. Without this helper the on-camera trade fails its approval. Pure decision function (`planDeposit`) + live executor (`ensureDollarCollateral`) + a `deposit` CLI command, with a free `staticCall` dry-run before the real supply.

**Files:**
- Create: `src/aave.ts`, `tests/aave-plan.test.ts`
- Modify: `src/core.ts` (extract `signerFromEnv`), `src/cli.ts` (`deposit` command, `whoami` shows dollar-collateral balances, execute path auto-ensures collateral), `package.json` (`deposit` script)

**Interfaces:**
- Consumes: `readClient`/`writeClient`, `client.erc20.getBalance/getSymbol/ensureAllowance`, `STRATEGY_VAULT_CONFIG.aave.pool` (exported by the SDK; Aave V3 Pool on Base).
- Produces:
  - `signerFromEnv(provider: ethers.Provider): ethers.Wallet` exported from `src/core.ts` (used by `writeClient` and `src/aave.ts`)
  - `type DepositPlan = { action: 'none' } | { action: 'deposit'; supplyUnits: bigint } | { action: 'blocked'; reason: string }`
  - `planDeposit(collateralBal: bigint, neededUnits: bigint, collateralSymbol: string, usdcBal: bigint): DepositPlan` (pure)
  - `ensureDollarCollateral(client: ThetanutsClient, token: string, neededUnits: bigint): Promise<{ deposited: boolean; hash?: string }>`

- [ ] **Step 1: Extract `signerFromEnv` in core**

In `src/core.ts`, refactor `writeClient` so the wallet construction is reusable:

```ts
/** Burner wallet from .env. Exported so helpers (e.g. the Aave deposit) can sign without a second env-parsing path. */
export function signerFromEnv(provider: ethers.Provider): ethers.Wallet {
  const pk = process.env.PRIVATE_KEY;
  if (!pk || pk === '0x') {
    throw new Error('PRIVATE_KEY missing. Copy .env.example to .env. BURNER WALLET ONLY.');
  }
  return new ethers.Wallet(pk, provider);
}

/** Signing client. Only needed for `execute()`. Requires PRIVATE_KEY. */
export function writeClient() {
  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  );
  const signer = signerFromEnv(provider);
  return new ThetanutsClient({ chainId: BASE_CHAIN_ID, provider, signer });
}
```

Run: `npm test` — expected PASS (pure refactor).

- [ ] **Step 2: Write the failing plan tests**

Create `tests/aave-plan.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planDeposit } from '../src/aave.js';

describe('planDeposit', () => {
  it('does nothing when the collateral balance already covers the need', () => {
    expect(planDeposit(15_000_000n, 10_000_000n, 'aBasUSDC', 0n)).toEqual({ action: 'none' });
  });

  it('deposits exactly the shortfall when short on aBasUSDC but holding USDC', () => {
    expect(planDeposit(4_000_000n, 10_000_000n, 'aBasUSDC', 20_000_000n)).toEqual({
      action: 'deposit',
      supplyUnits: 6_000_000n,
    });
  });

  it('blocks when USDC cannot cover the shortfall', () => {
    const plan = planDeposit(0n, 10_000_000n, 'aBasUSDC', 5_000_000n);
    expect(plan.action).toBe('blocked');
    expect((plan as any).reason).toMatch(/USDC/);
  });

  it('blocks for tokens with no auto-deposit path', () => {
    const plan = planDeposit(0n, 10_000_000n, 'cbBTC', 50_000_000n);
    expect(plan.action).toBe('blocked');
    expect((plan as any).reason).toMatch(/cbBTC/);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/aave-plan.test.ts`
Expected: FAIL — `src/aave.ts` doesn't exist.

- [ ] **Step 4: Implement `src/aave.ts`**

```ts
/**
 * USDC -> aBasUSDC via Aave V3 on Base.
 *
 * Buyable puts on the live book settle in aBasUSDC (Aave-wrapped USDC), not
 * raw USDC. This helper closes exactly that gap: if the wallet is short the
 * order's collateral token and that token is aBasUSDC, it supplies the
 * shortfall of raw USDC into the Aave pool (1:1, same 6 decimals) and gets
 * aBasUSDC back. Anything else is a loud, explicit "blocked".
 */
import { ethers } from 'ethers';
import { ThetanutsClient, STRATEGY_VAULT_CONFIG } from '@thetanuts-finance/thetanuts-client';
import { readClient, signerFromEnv, tokenSymbol } from './core.js';

const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
];

export type DepositPlan =
  | { action: 'none' }
  | { action: 'deposit'; supplyUnits: bigint }
  | { action: 'blocked'; reason: string };

/** Pure decision: what has to happen for the wallet to hold `neededUnits` of the collateral token. */
export function planDeposit(
  collateralBal: bigint,
  neededUnits: bigint,
  collateralSymbol: string,
  usdcBal: bigint
): DepositPlan {
  if (collateralBal >= neededUnits) return { action: 'none' };
  const shortfall = neededUnits - collateralBal;
  if (collateralSymbol !== 'aBasUSDC') {
    return {
      action: 'blocked',
      reason: `Short ${shortfall} units of ${collateralSymbol} and there is no auto-deposit path for it. Acquire it manually.`,
    };
  }
  if (usdcBal < shortfall) {
    return {
      action: 'blocked',
      reason: `Need ${shortfall} more units of aBasUSDC but the wallet only holds ${usdcBal} units of USDC. Top up USDC on Base first.`,
    };
  }
  return { action: 'deposit', supplyUnits: shortfall };
}

/**
 * Ensure the burner wallet holds `neededUnits` of `token` before a fill.
 * Executes the plan from `planDeposit`. Dry-runs the Aave supply with a free
 * staticCall before sending anything real.
 */
export async function ensureDollarCollateral(
  client: ThetanutsClient,
  token: string,
  neededUnits: bigint
): Promise<{ deposited: boolean; hash?: string }> {
  const provider = client.provider ?? readClient().provider!;
  const signer = signerFromEnv(provider);
  const me = await signer.getAddress();

  const usdcAddr = client.chainConfig.tokens.USDC.address;
  const [collateralBal, usdcBal, sym] = await Promise.all([
    client.erc20.getBalance(token, me),
    client.erc20.getBalance(usdcAddr, me),
    tokenSymbol(client, token),
  ]);

  const plan = planDeposit(BigInt(collateralBal), neededUnits, sym, BigInt(usdcBal));
  if (plan.action === 'none') return { deposited: false };
  if (plan.action === 'blocked') throw new Error(plan.reason);

  const pool = new ethers.Contract(STRATEGY_VAULT_CONFIG.aave.pool, AAVE_POOL_ABI, signer);

  // Exact-amount approval (never MaxUint256), then a FREE dry run before the real supply.
  await client.erc20.ensureAllowance(usdcAddr, STRATEGY_VAULT_CONFIG.aave.pool, plan.supplyUnits);
  await pool.supply.staticCall(usdcAddr, plan.supplyUnits, me, 0);
  const tx = await pool.supply(usdcAddr, plan.supplyUnits, me, 0);
  const receipt = await tx.wait();
  return { deposited: true, hash: receipt.hash };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Wire into the CLI**

In `src/cli.ts`:

1. Add imports: `import { ensureDollarCollateral } from './aave.js';` and add `collateralDecimals` to the core import list.
2. Add a `deposit` case:

```ts
    case 'deposit': {
      // npm run deposit -- 15   -> ensure the wallet holds 15 aBasUSDC-equivalents
      const amountUsdc = Number(args[0] ?? 15);
      const client = writeClient();
      const book = await getBook(client);
      const target = book.find((c) => !c.isCall && !c.makerIsBuyer);
      if (!target) { console.log('No buyable puts on the book to read a collateral token from.'); return; }
      const dec = await collateralDecimals(client, target.collateralToken);
      const units = BigInt(Math.round(amountUsdc * 10 ** dec));
      console.log(`Ensuring ${amountUsdc} of ${target.collateralToken} (the live book's buyable-put collateral)...`);
      const res = await ensureDollarCollateral(client, target.collateralToken, units);
      console.log(res.deposited ? `Deposited via Aave: https://basescan.org/tx/${res.hash}` : 'Already sufficient — nothing to do.');
      break;
    }
```

3. In the `execute` path (inside the shared quote/simulate/execute case, right before `console.log('\n*** SPENDING REAL USDC…')`), add the collateral ensure step:

```ts
      const wclient = writeClient();
      const dec = await collateralDecimals(wclient, pick.collateralToken);
      await ensureDollarCollateral(wclient, pick.collateralToken, BigInt(Math.round(q.spendUsdc * 10 ** dec)));
```

4. Extend `whoami` to show dollar-collateral balances, after the existing USDC line:

```ts
      const book = await getBook(client);
      const dollarSet = await dollarTokens(client, book);
      for (const t of dollarSet) {
        const sym = await tokenSymbol(client, t);
        const d = await collateralDecimals(client, t);
        const b = await client.erc20.getBalance(t, addr);
        console.log(`${sym.padEnd(9)} ${(Number(b) / 10 ** d).toFixed(4)}`);
      }
```

(Add `dollarTokens`, `tokenSymbol` to the core imports.)

5. In `package.json` scripts add: `"deposit": "tsx src/cli.ts deposit"`.

- [ ] **Step 7: Live smoke check (requires network + funded burner wallet)**

```bash
npm run whoami
npm run deposit -- 12
npm run whoami
```

Expected: first `whoami` shows USDC and (probably 0) aBasUSDC; `deposit` either supplies the shortfall through Aave and prints a BaseScan hash, or says "Already sufficient"; second `whoami` shows ≥12 aBasUSDC. This is a real (tiny) mainnet transaction — Aave deposits are reversible (withdrawable) and earn yield while parked.

- [ ] **Step 8: Commit**

```bash
git add src/aave.ts src/cli.ts src/core.ts package.json tests/aave-plan.test.ts
git commit -m "feat: Aave USDC->aBasUSDC deposit helper on the execute path (audit attack 1, critical-path TODO)"
```

---

### Task 6: Natural-language intent parsing via Gonka (FR1, Track 02 face)

One JSON extraction with strict validation. The LLM's entire job: three fields out of a sentence. It cannot smuggle a number into the product because everything it outputs is either replaced by live-book data or rejected by validation.

**Files:**
- Create: `src/intent.ts`, `tests/intent.test.ts`
- Modify: `src/cli.ts` (add `ask` command), `package.json` (`ask` script)

**Interfaces:**
- Consumes: `ProtectionSpec` from `src/core.ts`; env `GONKA_API_KEY`, `GONKA_BASE_URL`, `GONKA_MODEL`.
- Produces:
  - `type LlmClient = (system: string, user: string) => Promise<string>`
  - `gonkaLlm(): LlmClient` (fetch transport; throws without `GONKA_API_KEY`)
  - `parseIntent(text: string, llm: LlmClient): Promise<ProtectionSpec>` — throws descriptive errors on anything invalid
  - `validateSpec(obj: any): ProtectionSpec` (pure; also reused by the server in Task 8)

- [ ] **Step 1: Write the failing tests**

Create `tests/intent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseIntent, validateSpec } from '../src/intent.js';

const llmReturning = (s: string) => async () => s;

describe('parseIntent', () => {
  it('accepts clean JSON', async () => {
    const spec = await parseIntent('x', llmReturning('{"asset":"ETH","floorUsd":2300,"horizonDays":14}'));
    expect(spec).toEqual({ asset: 'ETH', floorUsd: 2300, horizonDays: 14 });
  });

  it('extracts JSON wrapped in prose', async () => {
    const spec = await parseIntent('x', llmReturning('Sure! {"asset":"BTC","floorUsd":60000,"horizonDays":30} there.'));
    expect(spec.asset).toBe('BTC');
  });

  it('rejects a non-protection request via the error field', async () => {
    await expect(parseIntent('x', llmReturning('{"error":"asked for a joke"}'))).rejects.toThrow(/Not a protection request/);
  });

  it('rejects unsupported assets', async () => {
    await expect(parseIntent('x', llmReturning('{"asset":"DOGE","floorUsd":1,"horizonDays":7}'))).rejects.toThrow(/Unsupported asset/);
  });

  it('rejects out-of-range horizons and floors', async () => {
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","floorUsd":2300,"horizonDays":400}'))).rejects.toThrow(/1-90/);
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","floorUsd":-5,"horizonDays":7}'))).rejects.toThrow(/floor/i);
  });

  it('rejects non-JSON garbage', async () => {
    await expect(parseIntent('x', llmReturning('I cannot help with that'))).rejects.toThrow(/no JSON/);
  });
});

describe('validateSpec', () => {
  it('round-trips a valid spec object', () => {
    expect(validateSpec({ asset: 'ETH', floorUsd: 2300, horizonDays: 14 })).toEqual({
      asset: 'ETH', floorUsd: 2300, horizonDays: 14,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/intent.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/intent.ts`**

```ts
/**
 * NL -> ProtectionSpec. The AI's ONLY job in the entire product (FR1).
 *
 * DESIGN RULE (the pitch, enforced in code): the LLM translates a sentence into
 * three fields and nothing else. Every field is strictly validated; every
 * number the user later sees comes from the live book, never from here.
 */
import type { ProtectionSpec } from './core.js';

export type LlmClient = (system: string, user: string) => Promise<string>;

/** OpenAI-compatible chat-completions transport for Gonka Router. */
export function gonkaLlm(): LlmClient {
  const base = process.env.GONKA_BASE_URL ?? 'https://api.gonkarouter.io/v1';
  const key = process.env.GONKA_API_KEY;
  const model = process.env.GONKA_MODEL ?? 'moonshotai/Kimi-K2.6';
  if (!key) throw new Error('GONKA_API_KEY missing in .env — see .env.example.');
  return async (system, user) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Gonka Router ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return json.choices?.[0]?.message?.content ?? '';
  };
}

const SYSTEM = `You translate a user's crypto-protection request into JSON. Output ONLY a JSON object, nothing else.
Fields: "asset" ("ETH" or "BTC" — the asset they hold), "floorUsd" (number — the minimum USD value they need), "horizonDays" (number — how many days until their deadline).
"two weeks" means 14. "a month" means 30. "end of next week" means about 10.
If the text is NOT a request to protect a crypto holding's value, output {"error":"<one short sentence why>"}.
Never invent a floor or horizon that is not stated or clearly implied by the text.`;

/** Strict validation — the only gate between LLM output and the product. Pure; reused by the server. */
export function validateSpec(obj: any): ProtectionSpec {
  const asset = obj?.asset;
  const floorUsd = Number(obj?.floorUsd);
  const horizonDays = Number(obj?.horizonDays);
  if (asset !== 'ETH' && asset !== 'BTC') {
    throw new Error(`Unsupported asset: ${JSON.stringify(obj?.asset)} — Payung protects ETH or BTC.`);
  }
  if (!Number.isFinite(floorUsd) || floorUsd < 1 || floorUsd > 10_000_000) {
    throw new Error(`Implausible floor price: ${JSON.stringify(obj?.floorUsd)}`);
  }
  if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 90) {
    throw new Error(`Horizon must be 1-90 days, got: ${JSON.stringify(obj?.horizonDays)}`);
  }
  return { asset, floorUsd, horizonDays };
}

export async function parseIntent(text: string, llm: LlmClient): Promise<ProtectionSpec> {
  const out = await llm(SYSTEM, text);
  const match = out.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse intent: the model returned no JSON.');
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    throw new Error('Could not parse intent: the model returned invalid JSON.');
  }
  if (obj.error) throw new Error(`Not a protection request: ${obj.error}`);
  return validateSpec(obj);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Add the `ask` CLI command**

In `src/cli.ts` add imports `import { parseIntent, gonkaLlm } from './intent.js';` and a case:

```ts
    case 'ask': {
      // npm run ask -- "I have 1 ETH and need it worth at least $2,300 in two weeks"
      const text = args.join(' ');
      if (!text) { console.log('usage: npm run ask -- "your constraint in plain words"'); return; }
      const spec = await parseIntent(text, gonkaLlm());
      console.log(`\nParsed: protect ${spec.asset} at a $${spec.floorUsd} floor for ${spec.horizonDays} days\n`);
      const candidates = await findCandidates(spec);
      if (!candidates.length) {
        console.log('No fillable structure matches that constraint right now.');
        console.log('(This is the correct answer. The agent does not improvise one.)');
        return;
      }
      candidates.forEach(show);
      break;
    }
```

In `package.json` scripts add: `"ask": "tsx src/cli.ts ask"`.

- [ ] **Step 6: Live smoke check (requires network + GONKA_API_KEY)**

```bash
npm run ask -- "I have 1 ETH and I need it to be worth at least 2300 dollars in two weeks"
npm run ask -- "tell me a joke"
```

Expected: first prints the parsed spec + live candidates; second exits with `Not a protection request: …`.

- [ ] **Step 7: Commit**

```bash
git add src/intent.ts src/cli.ts package.json tests/intent.test.ts
git commit -m "feat: NL intent parsing via Gonka with strict validation (FR1, track 02 face)"
```

---

### Task 7: Deterministic judgment layer (Audit Attack 6 — "where's the AI?")

The agent's visible judgment: premium-vs-value verdict and coverage honesty, computed from real numbers only (no LLM — determinism is the point; the LLM would add nothing but risk). This puts the "where it stops making sense" reasoning from PROJECT.md on screen.

**Files:**
- Create: `src/judgment.ts`, `tests/judgment.test.ts`
- Modify: `src/cli.ts` (print the verdict in the quote flow)

**Interfaces:**
- Consumes: `Quote` (Task 3 shape), `coverageGapDays` output (Task 4).
- Produces:
  - `type Judgment = { premiumPctOfProtection: number; verdict: 'reasonable' | 'expensive' | 'not-worth-it'; reasons: string[] }`
  - `judgeQuote(q: Quote, coverageGapDays: number): Judgment` (pure) — used by CLI here and the server in Task 8.

- [ ] **Step 1: Write the failing tests**

Create `tests/judgment.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { judgeQuote } from '../src/judgment.js';
import type { Quote } from '../src/core.js';

function q(over: Partial<Quote> = {}): Quote {
  return {
    requestedUsdc: 10, spendUsdc: 10, capped: false,
    collateralUsdc: 10, numContracts: '1', maxContracts: '100',
    pricePerContract: 19.94, premiumUsdc: 19.94,
    strike: 2300, expiry: new Date('2026-09-10T08:00:00Z'),
    yourSide: 'you buy the option', preview: {},
    ...over,
  };
}

describe('judgeQuote', () => {
  it('calls <5% of floor reasonable', () => {
    const j = judgeQuote(q({ pricePerContract: 19.94, strike: 2300 }), 0); // 0.87%
    expect(j.verdict).toBe('reasonable');
    expect(j.premiumPctOfProtection).toBeCloseTo(0.867, 2);
  });

  it('calls 5-10% expensive', () => {
    const j = judgeQuote(q({ pricePerContract: 161, strike: 2300 }), 0); // 7%
    expect(j.verdict).toBe('expensive');
  });

  it('calls >10% not worth it', () => {
    const j = judgeQuote(q({ pricePerContract: 300, strike: 2300 }), 0); // 13%
    expect(j.verdict).toBe('not-worth-it');
  });

  it('adds a coverage-gap reason when protection ends early', () => {
    const j = judgeQuote(q(), 5.3);
    expect(j.reasons.some((r) => /5\.3 days BEFORE/.test(r))).toBe(true);
  });

  it('has no coverage reason when the horizon is covered', () => {
    const j = judgeQuote(q(), 0);
    expect(j.reasons.some((r) => /BEFORE/.test(r))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/judgment.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/judgment.ts`**

```ts
/**
 * The agent's judgment, computed — never guessed.
 *
 * This is the visible AI surface for Track 02 beyond intent parsing: comparing
 * premium to the value protected, and refusing to pretend a bad buy is a good
 * one. Deliberately NOT an LLM call: judgment over real numbers should be
 * deterministic and auditable. (Thresholds are the 5-10% rule from PROJECT.md.)
 */
import type { Quote } from './core.js';

export type Judgment = {
  /** Premium as a percentage of the floor value it protects (per contract). */
  premiumPctOfProtection: number;
  verdict: 'reasonable' | 'expensive' | 'not-worth-it';
  reasons: string[];
};

export function judgeQuote(q: Quote, coverageGapDays: number): Judgment {
  const pct = (q.pricePerContract / q.strike) * 100;
  const reasons: string[] = [];
  let verdict: Judgment['verdict'];

  if (pct > 10) {
    verdict = 'not-worth-it';
    reasons.push(
      `Premium is ${pct.toFixed(1)}% of the floor it protects — you would be paying more for the insurance than the insurance is worth. A floor further below spot costs far less.`
    );
  } else if (pct > 5) {
    verdict = 'expensive';
    reasons.push(
      `Premium is ${pct.toFixed(1)}% of the floor — on the expensive side, because this floor sits close to the current price. Your call.`
    );
  } else {
    verdict = 'reasonable';
    reasons.push(
      `Premium is ${pct.toFixed(1)}% of the floor it protects — reasonable for this distance and window.`
    );
  }

  if (coverageGapDays > 0.25) {
    reasons.push(
      `This protection ends ${coverageGapDays.toFixed(1)} days BEFORE your stated deadline (${q.expiry.toISOString().slice(0, 10)}). After that date you are unprotected.`
    );
  }
  return { premiumPctOfProtection: pct, verdict, reasons };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Print the verdict in the CLI quote flow**

In `src/cli.ts`, import `judgeQuote` from `./judgment.js`, and after the payoff-curve print in the quote block add:

```ts
      const j = judgeQuote(q, gap);
      console.log(`\nagent verdict: ${j.verdict.toUpperCase()}`);
      j.reasons.forEach((r) => console.log(`  · ${r}`));
```

(`gap` already exists from Task 4's step 5.)

- [ ] **Step 6: Commit**

```bash
git add src/judgment.ts src/cli.ts tests/judgment.test.ts
git commit -m "feat: deterministic premium-vs-value judgment layer (audit attack 6)"
```

---

### Task 8: HTTP API server over the core

One thin `node:http` server: five JSON routes over core + static serving of `web/`. No framework (five routes don't justify one). Candidates carry BigInts and full raw orders, so the server keeps them in an in-memory cache keyed by a stable id and sends the UI a flat wire format.

**Files:**
- Create: `src/server.ts`, `tests/wire.test.ts`
- Modify: `package.json` (`web` script)

**Interfaces:**
- Consumes: `findCandidates`, `quote`, `simulate`, `execute`, `payoffCurve`, `coverageGapDays`, `collateralDecimals`, `writeClient` from core; `parseIntent`/`gonkaLlm`/`validateSpec` from intent; `judgeQuote` from judgment; `ensureDollarCollateral` from aave.
- Produces (HTTP, all JSON):
  - `POST /api/parse` `{text}` → `{spec: ProtectionSpec}` or 400 `{error}`
  - `POST /api/candidates` `{spec}` → `{candidates: WireCandidate[]}` where `WireCandidate = {id, strike, expiryIso, daysToExpiry, pricePerContract, iv, coverageGapDays, makerBudget}`
  - `POST /api/quote` `{id, spendUsdc}` → `{quote: {strike, expiryIso, requestedUsdc, spendUsdc, capped, premiumUsdc, pricePerContract, yourSide}, judgment: Judgment, payoff: {spot, pnl}[]}`
  - `POST /api/simulate` `{id, spendUsdc}` → `{ok, error?}`
  - `POST /api/execute` `{id, spendUsdc, confirm: true}` → `{hash, explorer, paidUsd}` (400 without `confirm`)
  - `GET /*` → static files from `web/`
  - Exported for tests: `candidateId(c: Candidate): string`, `toWire(c: Candidate, spec: ProtectionSpec): WireCandidate`, `jsonSafe(v: unknown): string`

- [ ] **Step 1: Write the failing wire-format tests**

Create `tests/wire.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { candidateId, toWire, jsonSafe } from '../src/server.js';
import { makeCandidate } from './fixtures.js';

const spec = { asset: 'ETH' as const, floorUsd: 2300, horizonDays: 14 };

describe('wire format', () => {
  it('candidateId is stable and derived from the order signature + strike', () => {
    const c = makeCandidate({ raw: { signature: '0xdeadbeefdeadbeefdeadbeef' } });
    expect(candidateId(c)).toBe(candidateId(c));
    expect(candidateId(c)).toContain('2300');
  });

  it('toWire carries no raw order and no bigints', () => {
    const w = toWire(makeCandidate({ daysToExpiry: 8.7 }), spec);
    expect((w as any).raw).toBeUndefined();
    expect(w.coverageGapDays).toBeCloseTo(5.3);
    expect(() => JSON.stringify(w)).not.toThrow();
  });

  it('jsonSafe serializes bigints as strings', () => {
    expect(jsonSafe({ a: 5n })).toBe('{"a":"5"}');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/wire.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
/**
 * Payung web server — a thin JSON API over src/core.ts plus static files
 * from web/. One app, two faces: the NL agent front door (Track 02) and the
 * floor-picker body (Track 01) are the same page talking to these routes.
 *
 * Candidates hold BigInts and full raw orders, so they never cross the wire:
 * the server caches them by id and the browser only ever sees flat numbers.
 */
import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import {
  findCandidates, quote, simulate, execute, payoffCurve, coverageGapDays,
  collateralDecimals, writeClient, type Candidate, type ProtectionSpec,
} from './core.js';
import { parseIntent, gonkaLlm, validateSpec } from './intent.js';
import { judgeQuote } from './judgment.js';
import { ensureDollarCollateral } from './aave.js';

const PORT = Number(process.env.PORT ?? 8787);
const WEB_ROOT = join(process.cwd(), 'web');

/** Candidates from the latest search, by id. One user, one demo — a Map is the right size. */
const cache = new Map<string, { candidate: Candidate; spec: ProtectionSpec }>();

export function candidateId(c: Candidate): string {
  return `${String(c.raw?.signature ?? '0x').slice(2, 18)}-${Math.round(c.strike)}`;
}

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

export function jsonSafe(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(jsonSafe(body));
}

function getCached(id: string) {
  const entry = cache.get(id);
  if (!entry) throw new Error('Unknown or stale candidate id — search again.');
  return entry;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

async function serveStatic(url: string, res: ServerResponse) {
  const path = url === '/' ? '/index.html' : url;
  const file = normalize(join(WEB_ROOT, path));
  if (!file.startsWith(WEB_ROOT)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = (req.url ?? '/').split('?')[0];

  if (req.method === 'POST' && url === '/api/parse') {
    const { text } = await readBody(req);
    if (!text) return send(res, 400, { error: 'Missing "text"' });
    const spec = await parseIntent(String(text), gonkaLlm());
    return send(res, 200, { spec });
  }

  if (req.method === 'POST' && url === '/api/candidates') {
    const body = await readBody(req);
    const spec = validateSpec(body.spec);
    const candidates = await findCandidates(spec);
    cache.clear();
    for (const c of candidates) cache.set(candidateId(c), { candidate: c, spec });
    return send(res, 200, { candidates: candidates.map((c) => toWire(c, spec)) });
  }

  if (req.method === 'POST' && url === '/api/quote') {
    const { id, spendUsdc } = await readBody(req);
    const { candidate, spec } = getCached(String(id));
    const q = await quote(candidate, Number(spendUsdc) || 10);
    const gap = coverageGapDays(candidate, spec);
    return send(res, 200, {
      quote: {
        strike: q.strike, expiryIso: q.expiry.toISOString(),
        requestedUsdc: q.requestedUsdc, spendUsdc: q.spendUsdc, capped: q.capped,
        premiumUsdc: q.premiumUsdc, pricePerContract: q.pricePerContract, yourSide: q.yourSide,
      },
      judgment: judgeQuote(q, gap),
      payoff: payoffCurve(q, [q.strike * 0.8, q.strike * 1.2], 40),
    });
  }

  if (req.method === 'POST' && url === '/api/simulate') {
    const { id, spendUsdc } = await readBody(req);
    const { candidate } = getCached(String(id));
    const sim = await simulate(candidate, Number(spendUsdc) || 10);
    return send(res, 200, { ok: sim.ok, error: sim.error });
  }

  if (req.method === 'POST' && url === '/api/execute') {
    const { id, spendUsdc, confirm } = await readBody(req);
    if (confirm !== true) return send(res, 400, { error: 'Set confirm:true — this spends real USDC on Base mainnet.' });
    const { candidate } = getCached(String(id));
    const spend = Number(spendUsdc) || 10;
    const client = writeClient();
    const dec = await collateralDecimals(client, candidate.collateralToken);
    await ensureDollarCollateral(client, candidate.collateralToken, BigInt(Math.round(spend * 10 ** dec)));
    const result = await execute(candidate, spend, client);
    return send(res, 200, { hash: result.hash, explorer: result.explorer, paidUsd: result.paidUsd });
  }

  if (req.method === 'GET') return serveStatic(url, res);
  return send(res, 404, { error: 'not found' });
}

// Only start listening when run directly (so tests can import the pure helpers).
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  createServer((req, res) => {
    route(req, res).catch((e: any) =>
      send(res, 500, { error: e?.shortMessage || e?.message || String(e) })
    );
  }).listen(PORT, () => {
    console.log(`Payung running at http://localhost:${PORT} — BASE MAINNET, real orders.`);
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (wire tests import the helpers without starting the listener).

- [ ] **Step 5: Add the script and smoke-check the routes (requires network)**

In `package.json` scripts add: `"web": "tsx src/server.ts"`.

```bash
npm run web &
sleep 3
curl -s localhost:8787/api/candidates -X POST -H 'content-type: application/json' \
  -d '{"spec":{"asset":"ETH","floorUsd":2300,"horizonDays":14}}' | head -c 600; echo
curl -s localhost:8787/ | head -c 200; echo
kill %1
```

Expected: first curl returns `{"candidates":[{"id":…,"strike":…}]}` with live data; second returns the start of `web/index.html`.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts package.json tests/wire.test.ts
git commit -m "feat: thin HTTP API over the core + static web serving"
```

---

### Task 9: Wire the web UI to the real API (one app, two faces)

Replace the mock-data script in `web/index.html` with real API calls, add the NL front door, and surface the judgment verdict, coverage-gap warnings, capping, and the real BaseScan hash. Keep the existing visual design — only the `<script>` block, the mock banner, and the step-1 markup change.

**Files:**
- Modify: `web/index.html` (banner, step-1 markup, entire `<script>` block)

**Interfaces:**
- Consumes: the exact HTTP routes from Task 8 (`/api/parse`, `/api/candidates`, `/api/quote`, `/api/simulate`, `/api/execute`) and their wire shapes.
- Produces: the demo surface for both tracks.

- [ ] **Step 1: Replace the mock banner**

Replace the `mock-banner` div contents with:

```html
  <div class="mock-banner">
    LIVE — every candidate below is a real, currently-fillable order on Base mainnet, priced by the protocol's own math. Execute spends real USDC.
  </div>
```

- [ ] **Step 2: Add the NL front door to step 1**

Inside `#step1`, directly above the existing `.field-row`, add:

```html
    <div class="field" style="margin-bottom:12px;">
      <label>Say it in your own words — the AI fills the form; it never invents a price</label>
      <div style="display:flex; gap:8px;">
        <input id="nl" type="text" style="flex:1; background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:10px 12px; color:var(--text); font-size:14px;"
               placeholder='e.g. "I have 1 ETH and need it worth at least $2,300 in two weeks"' />
        <button class="btn secondary" id="nlBtn" onclick="parseNL()">Parse</button>
      </div>
      <div id="nlError" style="color:var(--danger); font-size:12px; margin-top:6px;"></div>
    </div>
```

- [ ] **Step 3: Replace the entire `<script>` block**

```html
<script>
let state = { candidates: [], selected: null, quote: null };

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function restateSentence() {
  const asset = document.getElementById('asset').value;
  const amount = document.getElementById('amount').value || '1';
  const floor = Number(document.getElementById('floor').value || 0).toLocaleString();
  const days = document.getElementById('days').value || '14';
  document.getElementById('restated').innerHTML =
    `"I have <b>${amount} ${asset}</b>. I need it to be worth at least <b class="accent">$${floor}</b> in <b>${days} days</b>."`;
}
['asset','amount','floor','days'].forEach(id =>
  document.getElementById(id).addEventListener('input', restateSentence)
);

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
    err.textContent = e.message; // includes the honest "not a protection request" refusals
  } finally {
    btn.disabled = false; btn.textContent = 'Parse';
  }
}

function setStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById('step' + i);
    el.classList.remove('active', 'done');
    if (i < n) el.classList.add('done');
    if (i === n) el.classList.add('active');
  }
}

function currentSpec() {
  return {
    asset: document.getElementById('asset').value,
    floorUsd: Number(document.getElementById('floor').value),
    horizonDays: Number(document.getElementById('days').value),
  };
}

async function findFloors() {
  setStep(2);
  document.getElementById('candLoading').style.display = 'block';
  document.getElementById('candidateList').style.display = 'none';
  document.getElementById('candVerdict').style.display = 'none';
  try {
    const { candidates } = await api('/api/candidates', { spec: currentSpec() });
    state.candidates = candidates;
    document.getElementById('candLoading').style.display = 'none';
    if (!candidates.length) {
      const v = document.getElementById('candVerdict');
      v.style.display = 'block';
      v.innerHTML = '<b>No fillable structure matches that constraint right now.</b> That is the honest answer — nothing on the live book fits, and Payung never substitutes a near-miss silently. Try a different floor or window.';
      return;
    }
    renderCandidates(candidates);
    document.getElementById('candidateList').style.display = 'flex';
  } catch (e) {
    document.getElementById('candLoading').textContent = 'Error: ' + e.message;
  }
}

function renderCandidates(list) {
  const el = document.getElementById('candidateList');
  el.innerHTML = '';
  list.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'candidate';
    div.onclick = () => selectCandidate(i, div);
    const gapBadge = c.coverageGapDays > 0.25
      ? `<span class="badge warn">ends ${c.coverageGapDays.toFixed(1)}d early</span>` : '';
    const bestBadge = i === 0 ? '<span class="badge good">closest match</span>' : '';
    div.innerHTML = `
      <div>
        <div class="strike">$${c.strike.toLocaleString()} floor ${bestBadge}${gapBadge}</div>
        <div class="meta">${c.daysToExpiry.toFixed(1)}d window · exp ${c.expiryIso.slice(0,10)} · put, buyable · iv ${c.iv ? c.iv.toFixed(2) : '—'}</div>
      </div>
      <div class="premium">
        <div class="amount">$${c.pricePerContract.toFixed(2)}</div>
        <div class="label">premium / contract</div>
      </div>
    `;
    el.appendChild(div);
  });
  selectCandidate(0, el.children[0]);
}

async function selectCandidate(i, el) {
  document.querySelectorAll('.candidate').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  state.selected = state.candidates[i];
  const verdict = document.getElementById('candVerdict');
  verdict.style.display = 'block';
  verdict.innerHTML = '<span class="spinner"></span> pricing with previewFillOrder()...';
  try {
    const spend = 10; // demo size; a ~$1 fill scores the same per the builder docs
    const data = await api('/api/quote', { id: state.selected.id, spendUsdc: spend });
    state.quote = data;
    verdict.innerHTML = `<b>Agent verdict: ${data.judgment.verdict.replace(/-/g, ' ')}.</b> ` +
      data.judgment.reasons.map(r => r).join(' ');
    setStep(3);
    drawPayoff(data);
    const q = data.quote;
    const capNote = q.capped
      ? ` (capped — this maker can only absorb $${q.spendUsdc.toFixed(2)} of your requested $${q.requestedUsdc.toFixed(2)})` : '';
    document.getElementById('payoffSummary').innerHTML =
      `You spend <b>$${q.spendUsdc.toFixed(2)}</b>${capNote} — that is your maximum loss; nothing more can ever be taken. ` +
      `If the price is below <b>$${q.strike.toLocaleString()}</b> at expiry (${q.expiryIso.slice(0,10)}), the contract pays you the difference in cash — your real coins are never sold. ` +
      `If it stays above, the contract expires and you are out the premium — but your coins are worth more anyway.`;
  } catch (e) {
    verdict.innerHTML = 'Quote failed: ' + e.message;
  }
}

function drawPayoff(data) {
  const svg = document.getElementById('payoffChart');
  const W = 600, H = 260, PAD = 40;
  const pts = data.payoff; // [{spot, pnl}] from the protocol's own math — never computed in the UI
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

function goToExecute() { setStep(4); }

async function runSimulate() {
  const btn = document.getElementById('simBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>callStaticFillOrder()...';
  document.getElementById('simResult').innerHTML = '';
  try {
    const sim = await api('/api/simulate', { id: state.selected.id, spendUsdc: state.quote.quote.spendUsdc });
    const el = document.createElement('div');
    el.className = 'sim-result' + (sim.ok ? ' ok' : '');
    el.textContent = sim.ok
      ? `✓ the real transaction would succeed against current chain state — nothing was spent to learn this`
      : `✗ would revert: ${sim.error} — nothing was spent`;
    document.getElementById('simResult').appendChild(el);
    document.getElementById('execBtn').disabled = !sim.ok;
  } catch (e) {
    document.getElementById('simResult').textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Re-simulate';
  }
}

async function runExecute() {
  const q = state.quote.quote;
  if (!confirm(`Spend $${q.spendUsdc.toFixed(2)} of real USDC on Base mainnet to buy this floor?`)) return;
  const btn = document.getElementById('execBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>fillOrder() on Base mainnet...';
  try {
    const res = await api('/api/execute', { id: state.selected.id, spendUsdc: q.spendUsdc, confirm: true });
    btn.textContent = 'Executed ✓';
    document.getElementById('txResult').innerHTML = `
      <div class="tx-card">
        <div class="tx-label">Real transaction on Base mainnet — you paid $${res.paidUsd.toFixed(2)} (read from Transfer logs)</div>
        <div class="tx-hash">${res.hash}</div>
        <div style="margin-top:10px;"><a href="${res.explorer}" target="_blank" rel="noopener">${res.explorer} →</a></div>
      </div>
    `;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Execute for real';
    document.getElementById('txResult').innerHTML =
      `<div class="sim-result">✗ ${e.message}</div>`;
  }
}

function resetFlow() {
  state = { candidates: [], selected: null, quote: null };
  document.getElementById('execBtn').disabled = true;
  document.getElementById('execBtn').textContent = 'Execute for real';
  document.getElementById('simBtn').textContent = 'Simulate fill (free)';
  document.getElementById('simResult').innerHTML = '';
  document.getElementById('txResult').innerHTML = '';
  setStep(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
</script>
```

- [ ] **Step 4: Verify in the browser (requires network)**

```bash
npm run web
```

Open `http://localhost:8787` and walk the flow:
1. Type a plain-English constraint → Parse → form fields fill.
2. Find real offers → live candidates appear with premiums and any "ends N d early" badges.
3. Select one → agent verdict sentence + payoff curve from server data.
4. Simulate → green "would succeed" (or an honest revert message).
5. Do **not** execute yet — that's Task 11's scripted moment. Confirm the execute button asks for confirmation and then cancel.
6. Also verify the empty case: ask for an absurd floor (e.g. $9,000 ETH floor, 3 days) → the honest "no fillable structure" message, no invented candidates (FR9).

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat: wire web UI to live API — NL front door, judgment, coverage badges, real execute"
```

---

### Task 10: Documentation truth fixes (Audit Attack 5 + stale confirmed fact)

Two docs lies to fix before a judge finds them: the stop-loss table claims path protection that a European put doesn't give, and the "confirmed facts" section contradicts whatever Task 2's live check found.

**Files:**
- Modify: `PROJECT.md` (comparison table ~lines 94–101, confirmed facts ~line 169, status list ~lines 191–200)

**Interfaces:** none — prose only.

- [ ] **Step 1: Fix the comparison table**

In `PROJECT.md`, replace the table row:

```markdown
| **In a fast crash** | Can fill far below your trigger price if the order book is thin (common in crypto) — this happens constantly | Floor holds exactly, because it's computed, not executed into a live market |
```

with:

```markdown
| **In a fast crash** | Can fill far below your trigger price if the order book is thin (common in crypto) — this happens constantly | The floor is computed at the deadline, not executed into a live market — it cannot slip. But it protects a **date**, not the path: a mid-window dip that recovers by expiry pays nothing |
| **What's protected** | The path — continuously, but only best-effort | One date — exactly. Real constraints have dates: tuition due, loan due |
| **What it costs** | Free to place | A premium, paid upfront (roughly 5–10% of protected value near the money — see the pricing table) |
```

And replace the one-sentence version below the table:

```markdown
The one-sentence version: *a stop-loss is a best-effort order that can miss its own price in a fast crash and takes you out of your position; a put option is a contractual floor that is computed exactly at your deadline — it costs a premium and protects a date rather than the path, and you keep your asset and its upside the whole time.*
```

- [ ] **Step 2: Fix the stale confirmed fact**

Replace the line:

```markdown
- **No buyable puts are collateralized in raw USDC** — they settle in `aBasUSDC` (Aave-wrapped USDC on Base). Buying protection requires depositing USDC into Aave first. This is a minor extra step, and a genuine positive for the pitch: idle collateral earns Aave yield while it sits.
```

with the empirically observed answer recorded in Task 2 Step 5 (whichever it was), phrased as:

```markdown
- **Buyable-put collateral, re-verified <date of Task 2 run>:** the live book quoted `<observed tokens>` for buyable puts. `findCandidates()` accepts any dollar-denominated collateral (USDC or aBasUSDC) discovered from the live book by symbol — never a hardcoded address — and the execute path auto-deposits USDC into Aave when an order needs `aBasUSDC` (a genuine positive: idle collateral earns Aave yield while it sits).
```

- [ ] **Step 3: Update the status checklist**

Tick the now-done items and reword the remaining ones to match reality (Aave helper ✓, NL parsing ✓, consumer UI ✓ once Task 9 landed; leave "first real on-chain fill" and "demo video + README" unticked — they are Task 11).

- [ ] **Step 4: Commit**

```bash
git add PROJECT.md
git commit -m "docs: date-not-path honesty in stop-loss table; re-verified collateral fact (audit attack 5)"
```

---

### Task 11: Preflight command, demo runbook, first real fill, and submission README (Audit Attacks 7–8)

The book turns over constantly (342→403 orders in one observed session) — the rehearsed order will be gone at pitch time. The bar is "at least one real trade," not "a live trade during the pitch": execute the real fill early, keep the hash, and attempt a live fill as theater with fallbacks.

**Files:**
- Create: `docs/demo-runbook.md`, `README.md`
- Modify: `src/cli.ts` (add `preflight`), `package.json` (`preflight` script)

**Interfaces:**
- Consumes: `findCandidates`, `simulate`, `coverageGapDays` from core.
- Produces: `npm run preflight -- <floor> <days>` — candidate freshness + fillability check to run minutes before demoing.

- [ ] **Step 1: Add the `preflight` CLI command**

In `src/cli.ts`:

```ts
    case 'preflight': {
      // Run minutes before the demo: is the pipeline alive, and which candidates are actually fillable RIGHT NOW?
      const spec = {
        asset: 'ETH' as const,
        floorUsd: Number(args[0] ?? 2300),
        horizonDays: Number(args[1] ?? 14),
      };
      const t0 = Date.now();
      const candidates = await findCandidates(spec);
      console.log(`\nbook+filter latency ${Date.now() - t0}ms · ${candidates.length} candidates for $${spec.floorUsd}/${spec.horizonDays}d`);
      if (!candidates.length) { console.log('NO CANDIDATES — adjust the demo constraint before going on stage.'); return; }
      for (const c of candidates.slice(0, 3)) {
        const sim = await simulate(c, 10);
        const gap = coverageGapDays(c, spec);
        console.log(
          `  strike ${usd(c.strike)} exp ${c.expiry.toISOString().slice(0, 10)}` +
          `${gap > 0.25 ? ` (ends ${gap.toFixed(1)}d early)` : ''}: ` +
          (sim.ok ? '✓ fillable right now' : `✗ ${sim.error}`)
        );
      }
      console.log('\nUse the top ✓ candidate on stage; the other two are your fallbacks.\n');
      break;
    }
```

In `package.json` scripts add: `"preflight": "tsx src/cli.ts preflight"`.

Run (requires network + PRIVATE_KEY): `npm run preflight -- 2300 14`
Expected: latency line + up to 3 candidates each marked fillable or not.

- [ ] **Step 2: Write the demo runbook**

Create `docs/demo-runbook.md`:

```markdown
# Payung — demo runbook

The bar is "at least one real trade against live pricing" — not "a live trade during the pitch."
The banked trade is the submission; the live attempt is theater.

## Days before

- [ ] `BASE_RPC_URL` in `.env` is a paid/free-tier Alchemy or Infura key — NOT `mainnet.base.org`,
      and NOT venue wifi + public RPC (that combination is how demos die).
- [ ] Burner wallet holds ~$20 USDC + ~$1 of ETH gas on Base. `npm run whoami` to confirm.
- [ ] **Execute the banked trade:** `npm run preflight -- 2300 14`, pick the top ✓ candidate,
      then run the full flow in the web app (or `npm run execute -- 2300 10`) and SAVE:
      - the BaseScan URL,
      - the "you paid $X" figure (from Transfer logs — this is the max-loss number),
      - a screen recording of the whole flow, NL sentence → hash (this is the backup video).
- [ ] Paste the hash + paid figure into README.md ("Proof" section).
- [ ] Confirm on Devfolio: registration done. Submit the one entry to BOTH tracks —
      the sponsor's workshop deck says explicitly: "Nothing stops one entry taking both
      tracks. If we're happy with it, you can win both."

## The pitch, in order

Judging (per the sponsor's workshop deck) scores exactly two things — "Does it work?" and
"Would anyone actually use it?" — not complexity, not the tech stack. So lead with the
user (tuition-due student burned by a stop-loss), end with the working product and the
hash, and close with "we plan to keep building this" (they explicitly support post-hackathon teams).

1. Say the positioning line (PROJECT.md "The pitch") — including that Gonka Router, our AI layer, is itself a MUBA sponsor.
2. Type the constraint in plain English. Show the parse — the AI's ONLY job.
3. Show live candidates + agent verdict (premium-vs-value judgment, coverage-gap honesty).
4. Show the payoff curve. Say the max-loss line: "what leaves the wallet today, nothing more."
5. Simulate — free, against current chain state.
6. Attempt the live fill. If it succeeds: fresh hash on screen. If the order was taken:
   say "the book moved — which is why every number here is live" and show the banked
   BaseScan link. Either way you end on a real hash.

## Minutes before

- [ ] `npm run preflight -- <floor> <days>` — confirms RPC latency and 3 fillable fallbacks.
- [ ] Web app running (`npm run web`), page loaded, wallet funded.
- [ ] Backup video open in a tab.

## If everything is on fire

The banked BaseScan link and the recording ARE the demo. A verified mainnet transaction
hash needs no live wifi to be convincing.
```

- [ ] **Step 3: Write the submission README**

Create `README.md`:

```markdown
# ☂ Payung

*Payung* — Malay for "umbrella." You buy protection before it rains.

Tell it what you're afraid of losing, in plain language. It finds a real, currently-fillable
put option on the live Thetanuts orderbook on **Base mainnet**, shows you exactly what the
floor costs using the protocol's own pricing math, simulates the exact transaction for free,
and — only after you confirm — executes it for real and hands you the BaseScan hash.

Built for **MUBA Hacks 2026** — Thetanuts Track 01 (SDK Product) and Track 02 (AI × Options).

## Proof (Track 02 bar: at least one real trade against live pricing)

- Transaction: `<BaseScan URL of the banked fill — from the demo runbook>`
- Paid: `$<amount>` (read from the fill receipt's Transfer logs — this is also the buyer's max loss)

## Why the options are load-bearing

A put option is the *correct instrument* for "I need my ETH worth at least $X by date Y":
a cash-settled contractual floor computed at a deadline. It cannot slip the way a stop-loss
fills below its trigger in a thin book, and it never touches the user's actual coins. Stub
out the Thetanuts calls and there is no product — every candidate, premium, and payoff
figure comes from `fetchOrders()` / `previewFillOrder()` live.

## Who it's for

Crypto holders with a hard deadline and a hard floor — tuition due, loan due — who have
been burned by stop-losses or don't want to learn options jargon to protect themselves.

## The AI (and what it is not allowed to do)

The LLM (Gonka Router — a MUBA sponsor) does exactly one job: parse a sentence into
`{asset, floorUsd, horizonDays}`, strictly validated. It never generates a price, a
prediction, or any number the user sees. The agent's *judgment* — premium-vs-value verdict,
coverage-gap warnings, refusing to improvise when nothing on the book fits — is computed
deterministically from live data (`src/judgment.ts`).

## Run it

```bash
npm install
cp .env.example .env   # burner wallet key + Alchemy/Infura Base RPC + Gonka key
npm test               # pure-function tests, no network
npm run book           # live orderbook (read-only)
npm run ask -- "I have 1 ETH and need it worth at least $2,300 in two weeks"
npm run web            # http://localhost:8787 — the full product
```

Execution path safeguards: buyable-puts-only filter (you can never accidentally write
options), underlying-asset filter, maker-budget capping (never silent), order-staleness
guard, free `callStaticFillOrder()` before every real send, exact-amount approvals,
automatic USDC→aBasUSDC Aave deposit when an order needs it.

## Architecture

One core (`src/core.ts`) is the only module that touches Thetanuts. The CLI (`src/cli.ts`),
the HTTP API (`src/server.ts`), and the web UI (`web/`) are thin faces over it.
Spec: [Payung_Spec.md](Payung_Spec.md) · Pitch & Q&A: [PROJECT.md](PROJECT.md)

## After the hackathon

We plan to keep building this: roadmap is an autonomous re-hedge agent (watch a position,
roll protection as expiries pass — Track 02's "autonomous hedging" idea, deliberately
scoped out of the hackathon build) and RFQ support for exact strikes/expiries when the
book has no match.
```

- [ ] **Step 4: Execute the banked trade (requires network, funded wallet — SPENDS REAL MONEY, ~$10)**

Follow the runbook's "days before" section now:

```bash
npm run preflight -- 2300 14
npm run execute -- 2300 10
```

Paste the resulting BaseScan URL and paid amount into README.md's Proof section, and tick the "first real on-chain fill" box in PROJECT.md's status list. **This is the single deliberate real-money step in the whole plan** — everything before it was free simulation.

- [ ] **Step 5: Full verification pass**

```bash
npm test          # all suites green
npm run book      # live read path
npm run web       # walk the UI end-to-end once more
```

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts package.json docs/demo-runbook.md README.md PROJECT.md
git commit -m "feat: preflight command, demo runbook, submission README with real fill proof"
```

---

## Self-review (performed while writing)

- **Spec coverage:** FR1 → Task 6; FR2 → existing `getBook` + Task 1; FR3 → Task 2 (`makerIsBuyer` filter preserved + tested); FR4 → existing `quote()` + Task 3; FR5 → Tasks 3/9 (payoff + max-loss before confirm); FR6 → existing `simulate` + wired in Tasks 8/9; FR7 → Task 8 (`confirm:true` gate) + Task 9 (`confirm()` dialog) + `execute()`'s internal sim; FR8 → Task 3 (`hash`, `explorer`, `paidUsd`); FR9 → Task 2 (empty list honest) + Task 9 (empty-state UI). Edge cases: no-match → FR9; sim revert → `execute()` refusal + UI message; missing collateral → Task 5; stale order → Task 3 `assertFillable`; maker budget → Task 3 `capSpend`.
- **Open spec items resolved:** tie-breaking defaults to strike-distance ranking (unchanged, now tested); Aave UX is in-app auto-deposit on the execute path (Task 5); autonomous re-hedge is out of scope, described as roadmap only.
- **Type consistency check:** `makerBudget` (not `makerBudgetUsdc`) everywhere from Task 1 on; `quote(candidate, requestedUsdc)` shape used by CLI (Task 3), server (Task 8); `coverageGapDays(c, spec)` signature identical in Tasks 4/7/8/11; `WireCandidate` fields in Task 8 match what Task 9's UI reads (`id, strike, expiryIso, daysToExpiry, pricePerContract, iv, coverageGapDays`); `/api/quote` response `{quote, judgment, payoff}` matches `state.quote` usage in Task 9.
- **Placeholder scan:** the only intentional placeholder is README's Proof section, which Task 11 Step 4 fills with the real hash — that's a deliberate post-trade step, not a plan gap.
