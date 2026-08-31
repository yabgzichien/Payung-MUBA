/**
 * Payung — execution core.
 *
 * This module is the ONLY place that touches Thetanuts. Both surfaces
 * (the AI agent for Track 02, the consumer product for Track 01) call into
 * these functions. Keep all protocol knowledge here.
 *
 * DESIGN RULE — this is your pitch, so enforce it in code:
 *   The LLM never produces a number. It only chooses among candidates
 *   returned by `findCandidates()` and explains them. Every price, premium,
 *   and collateral figure comes from the live book or the SDK's own math.
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import { impliedStrike, type ProtectionSpec } from './spec';

export const BASE_CHAIN_ID = 8453;
export const USDC_DECIMALS = 6;
export const STRIKE_DECIMALS = 8; // strikes come back as 1e8, e.g. 236000000000 -> $2360

/** Read-only client. Use for browsing, quoting, simulating. Costs nothing. */
export function readClient() {
  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  );
  return new ThetanutsClient({ chainId: BASE_CHAIN_ID, provider });
}

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

export type Candidate = {
  raw: any;
  isCall: boolean;
  /**
   * True if YOU (the taker) are the buyer on this order.
   *
   * Named for what the chain actually does, which is the OPPOSITE of what the
   * field name `order.isBuyer` suggests. Verified on Base mainnet from a
   * non-maker wallet holding $4.02:
   *   isBuyer=true  -> fill reaches the ERC20 transfer even when contracts x
   *                    strike is $19,721, i.e. no collateral is demanded.
   *                    Taker pays only the premium => taker is the BUYER.
   *   isBuyer=false -> Panic(0x11) collateral-short at every size, including
   *                    dust. Taker must post contracts x strike => taker is
   *                    the SELLER (writing the put).
   * Corroborated by a real settled purchase (tx 0x2570c9dd…): sellerWasMaker,
   * and the taker transferred only the $9.999955 premium.
   */
  takerIsBuyer: boolean;
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

/**
 * GOTCHA: `getPriceDecimals()` returns the SCALE (1e8 as a bigint), not a
 * decimal count. Treating it as a count silently gives you zero. Divide by
 * the returned value directly.
 */
let _priceScale: number | null = null;
export async function priceScale(client: ThetanutsClient): Promise<number> {
  if (_priceScale === null) {
    _priceScale = Number(await client.optionBook.getPriceDecimals());
  }
  return _priceScale;
}

/** Collateral is NOT always USDC — the book also quotes WETH and cbBTC. */
const _decCache = new Map<string, number>([
  ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 6], // USDC
  ['0x4e65fe4dba92790696d040ac24aa414708f5c0ab', 6], // aBasUSDC
  ['0x4200000000000000000000000000000000000006', 18], // WETH
  ['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 8], // cbBTC
]);
export async function collateralDecimals(client: ThetanutsClient, token: string) {
  const key = token.toLowerCase();
  if (!_decCache.has(key)) {
    _decCache.set(key, Number(await client.erc20.getDecimals(token)));
  }
  return _decCache.get(key)!;
}

/** Pure decode of one raw SDK order. Exported for tests — no network, no Date.now(). */
export function decodeOrder(o: any, scale: number, nowSec: number, collateralDec: number): Candidate {
  const expirySec = Number(o.order.expiry);
  const takerIsBuyer = Boolean(o.order.isBuyer);
  return {
    raw: o,
    isCall: Boolean(o.rawApiData?.isCall),
    takerIsBuyer,
    // See takerIsBuyer above: isBuyer=true is the side where the taker pays
    // only the premium, i.e. the side that BUYS. Reading it the other way
    // labelled write-the-put orders as "you buy the option".
    yourSide: takerIsBuyer ? 'you buy the option' : 'you sell the option',
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

export type { ProtectionSpec } from './spec';
export { impliedStrike } from './spec';

export type FilterConfig = {
  /** Lowercase collateral-token addresses treated as dollar-denominated (USDC, aBasUSDC). */
  dollarTokens: Set<string>;
  /** Lowercase Chainlink feed address for the spec's underlying asset. */
  assetPriceFeed: string;
};

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
  const eligible = book
    // A floor under a long asset position is a PUT — the correct instrument,
    // not a judgement call or a prediction.
    .filter((c) => !c.isCall)
    // CRITICAL: to BUY protection you must be the buyer. This predicate was
    // previously inverted (`!c.makerIsBuyer`), which kept precisely the
    // orders where the taker WRITES the put — the naked-put case this line
    // exists to prevent. It also explained the collateral demand users hit:
    // sellers must post contracts x strike, buyers owe only the premium.
    .filter((c) => c.takerIsBuyer)
    // CRITICAL: protection must be on the asset the user actually holds.
    // The book is multi-asset; strike distance is NOT a proxy for underlying.
    .filter((c) => c.priceFeed === cfg.assetPriceFeed)
    // Dollar-denominated collateral only, so premiums are in dollars. The live
    // book quotes buyable puts in aBasUSDC (Aave-wrapped USDC), not raw USDC.
    .filter((c) => cfg.dollarTokens.has(c.collateralToken.toLowerCase()))
    .filter((c) => c.daysToExpiry >= spec.horizonDays * 0.6)
    .filter((c) => c.daysToExpiry <= spec.horizonDays * 2.5);
  return rankCandidates(eligible, spec);
}

/**
 * How many days short of the user's stated deadline this option's protection
 * ends. > 0 means the floor evaporates BEFORE the date the user asked for —
 * allowed, but it must be surfaced loudly, never silently (FR/audit attack 4).
 */
export function coverageGapDays(c: Candidate, spec: ProtectionSpec): number {
  return Math.max(0, spec.horizonDays - c.daysToExpiry);
}

/** ERC20 symbol, cached per token address. */
const _symCache = new Map<string, string>([
  ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC'],
  ['0x4e65fe4dba92790696d040ac24aa414708f5c0ab', 'aBasUSDC'],
  ['0x4200000000000000000000000000000000000006', 'WETH'],
  ['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 'cbBTC'],
]);
export async function tokenSymbol(client: ThetanutsClient, token: string): Promise<string> {
  const key = token.toLowerCase();
  if (!_symCache.has(key)) {
    try {
      _symCache.set(key, await client.erc20.getSymbol(token));
    } catch {
      _symCache.set(key, 'UNKNOWN');
    }
  }
  return _symCache.get(key)!;
}

/**
 * Base mainnet addresses confirmed by direct on-chain symbol()/decimals() calls
 * during this branch's live verification (see task-2-report.md). Not a
 * replacement for live discovery below — a defense-in-depth allowlist so a
 * spoofed ERC20 whose symbol() merely ENDS in "USDC" can't pass as trusted
 * dollar collateral by address-match alone.
 */
const KNOWN_DOLLAR_TOKENS = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base mainnet
  '0x4e65fe4dba92790696d040ac24aa414708f5c0ab', // aBasUSDC (Aave Base USDC) — the live book's buyable-put collateral
]);

/**
 * Which collateral tokens in this book are dollar-denominated?
 * Discovered from the live book by symbol (USDC, aBasUSDC), never hardcoded —
 * the book has changed its quoting token before and can again.
 *
 * Tradeoff: an exact-address match (allowlist, or the SDK's own known-USDC
 * address) is trusted outright; a bare symbol()-suffix match is kept ONLY as a
 * fallback for tokens not yet in the allowlist, so the book can still add new
 * dollar-denominated collateral over time without a code change — at the cost
 * of trusting an unverified ERC20's self-reported symbol for those tokens.
 */
export async function dollarTokens(
  client: ThetanutsClient,
  book: Candidate[]
): Promise<Set<string>> {
  const distinct = [...new Set(book.map((c) => c.collateralToken.toLowerCase()))];
  const allowlist = new Set(KNOWN_DOLLAR_TOKENS);
  const canonicalUsdc = client.chainConfig?.tokens?.USDC?.address?.toLowerCase();
  if (canonicalUsdc) allowlist.add(canonicalUsdc);

  const out = new Set<string>();
  for (const t of distinct) {
    if (allowlist.has(t)) { out.add(t); continue; }
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

/**
 * Cap a requested spend to what the maker can still absorb. Never silent: the
 * flag travels to the UI.
 *
 * `makerBudget` is denominated in COLLATERAL dollars, not premium dollars —
 * for a cash-secured put the SDK's own rule is `maxContracts = makerBudget /
 * strike` (OptionBookModule.calculateMaxContracts), and the actual premium
 * ceiling is `maxContracts × pricePerContract`. That ceiling is smaller than
 * makerBudget by roughly strike/price (often ~1-2 orders of magnitude) —
 * comparing requestedUsdc directly to makerBudget under-caps by that same
 * factor and lets a fill silently settle for far less than requested.
 */
export function capSpend(
  requestedUsdc: number,
  makerBudget: number,
  strike: number,
  pricePerContract: number
): { spendUsdc: number; capped: boolean } {
  const maxPremiumUsdc = (makerBudget / strike) * pricePerContract;
  if (requestedUsdc <= maxPremiumUsdc) return { spendUsdc: requestedUsdc, capped: false };
  return { spendUsdc: maxPremiumUsdc, capped: true };
}

/**
 * Refuse to send against an order that expires within the buffer. The fix is
 * a fresh quote, so say so.
 *
 * Checks the EARLIER of two distinct expiries: the option's own expiry (when
 * the contract itself lapses) and the maker order's `orderExpiryTimestamp`
 * (when the maker's signed quote itself goes stale — typically minutes, not
 * weeks). Only the option expiry survives `findCandidates()`'s horizon
 * filter, so checking it alone leaves the order-level staleness window
 * completely unguarded.
 */
export function assertFillable(c: Candidate, nowSec: number, bufferSec = 60): void {
  const optionExpirySec = Math.floor(c.expiry.getTime() / 1000);
  const orderExpiryRaw = c.raw?.rawApiData?.orderExpiryTimestamp;
  const orderExpirySec = orderExpiryRaw !== undefined ? Number(orderExpiryRaw) : optionExpirySec;
  const expirySec = Math.min(optionExpirySec, orderExpirySec);
  if (expirySec <= nowSec + bufferSec) {
    throw new Error(
      `Order expires at ${new Date(expirySec * 1000).toISOString()} — too close to send safely. Re-quote and pick a fresh candidate.`
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
  /** Real contract count, decoded from preview.numContracts (6-decimal-scaled per SDK). */
  contracts: number;
  strike: number;
  expiry: Date;
  yourSide: Candidate['yourSide'];
  preview: any;
};

/**
 * Price a fill. Synchronous SDK call — this is the SDK's own collateral math.
 *
 * GOTCHA (confirmed against the SDK source): `previewFillOrder`'s
 * `totalCollateral` field is just an echo of the `usdcAmount` you passed in —
 * it is NOT strike × contracts, and it does not reflect maker-side clamping.
 * The real contract count is `preview.numContracts`, which the SDK docs
 * state is "6 decimals for USDC collateral" — i.e. divide by 1e6, not by
 * strike. Deriving contracts from collateral/strike (the previous approach
 * here) produced numbers off by roughly strike/price.
 */
export async function quote(
  candidate: Candidate,
  requestedUsdc: number,
  client = readClient()
): Promise<Quote> {
  const { spendUsdc, capped } = capSpend(
    requestedUsdc,
    candidate.makerBudget,
    candidate.strike,
    candidate.pricePerContract
  );
  const amount = BigInt(Math.round(spendUsdc * 10 ** USDC_DECIMALS));
  const preview: any = client.optionBook.previewFillOrder(candidate.raw, amount);
  const scale = await priceScale(client);

  const pricePerContract = Number(preview.pricePerContract) / scale;
  const contracts = Number(preview.numContracts) / 10 ** USDC_DECIMALS;

  return {
    requestedUsdc,
    spendUsdc,
    capped,
    collateralUsdc: Number(preview.totalCollateral) / 10 ** USDC_DECIMALS,
    numContracts: String(preview.numContracts),
    maxContracts: String(preview.maxContracts),
    pricePerContract,
    premiumUsdc: pricePerContract * contracts,
    contracts,
    strike: candidate.strike,
    expiry: candidate.expiry,
    yourSide: candidate.yourSide,
    preview,
  };
}

/**
 * Simulate the REAL transaction without spending anything.
 *
 * GOTCHA (confirmed against the SDK source): `callStaticFillOrder` does NOT
 * throw when the fill would revert — it catches internally and resolves
 * `{ success: false, error, ... }`. Treating "the promise resolved" as "the
 * fill would succeed" makes this function report success unconditionally,
 * which is worse than not calling it at all: every caller (CLI, web UI,
 * `preflight`, and `execute()`'s own pre-send guard) would believe a doomed
 * fill is safe to send. Must read `result.success`.
 */
export async function simulate(
  candidate: Candidate,
  collateralUsdc: number,
  client = writeClient()
): Promise<{ ok: boolean; result?: any; error?: string }> {
  const amount = BigInt(Math.round(collateralUsdc * 10 ** USDC_DECIMALS));
  try {
    const result = await client.optionBook.callStaticFillOrder(candidate.raw, amount);
    if (!result?.success) {
      return { ok: false, result, error: result?.error?.message ?? 'callStaticFillOrder reported failure' };
    }
    return { ok: true, result };
  } catch (e: any) {
    return { ok: false, error: e?.shortMessage || e?.message || String(e) };
  }
}

/**
 * Execute for real. Approves collateral, then fills.
 * Returns the tx hash you put on screen during the pitch.
 */
export async function execute(
  candidate: Candidate,
  spendUsdc: number,
  client = writeClient()
): Promise<{ hash: string; explorer: string; receipt: any; paidUnits: bigint; paidUsd: number | null }> {
  const dec = await collateralDecimals(client, candidate.collateralToken);
  if (dec !== USDC_DECIMALS) {
    // Every code path below assumes 6-decimal dollar collateral (USDC_DECIMALS).
    // A dollar-token with different decimals would silently mis-scale amounts
    // by the ratio — fail loudly instead.
    throw new Error(
      `${candidate.collateralToken} has ${dec} decimals, not the assumed ${USDC_DECIMALS}. Refusing to guess the scale.`
    );
  }
  const amount = BigInt(Math.round(spendUsdc * 10 ** USDC_DECIMALS));

  // Spec edge case: the order can expire between quoting and confirming.
  assertFillable(candidate, Math.floor(Date.now() / 1000));

  // Approve THIS order's collateral token, not a hardcoded USDC address.
  // Must happen BEFORE simulate(): callStaticFillOrder's transferFrom needs
  // the allowance in place to reflect the fill we're actually about to send.
  // Simulating first (against zero allowance) would report every fresh
  // wallet's first-ever fill as "would revert".
  await client.erc20.ensureAllowance(
    candidate.collateralToken,
    client.getContractAddress('optionBook'),
    amount
  );

  // Fail loudly before spending the fill's gas if it would still revert.
  const sim = await simulate(candidate, spendUsdc, client);
  if (!sim.ok) throw new Error(`Simulation failed, refusing to send: ${sim.error}`);

  const receipt: any = await client.optionBook.fillOrder(candidate.raw, amount);
  const rec = receipt?.receipt ?? receipt;
  const hash: string | undefined = rec?.hash ?? rec?.transactionHash;

  // CRITICAL: fillOrder() has already landed on-chain at this point. Everything
  // below is best-effort bookkeeping ("what did we pay?"), never grounds to
  // throw — a throw here would tell the caller the fill failed when in fact a
  // real, irreversible on-chain transaction just succeeded, inviting a
  // duplicate real-money retry. If we can't determine the paid amount, we
  // report it as unknown (paidUsd: null) rather than as an error.
  const me = await client.getSignerAddress();
  const paidUnits = sumDebits(rec?.logs ?? [], candidate.collateralToken, me);
  return {
    hash: hash ?? 'unknown',
    explorer: hash
      ? `https://basescan.org/tx/${hash}`
      : 'hash unknown — the fill landed on-chain but the receipt shape was unrecognized; check BaseScan for your wallet address',
    receipt,
    paidUnits,
    paidUsd: paidUnits === 0n ? null : Number(paidUnits) / 10 ** dec,
  };
}

/** Payoff curve for the UI. Pure math — no network, no LLM. */
export function payoffCurve(q: Quote, spotRange: [number, number], points = 60) {
  const [lo, hi] = spotRange;
  const { contracts } = q;
  const youBuy = q.yourSide === 'you buy the option';
  const out: { spot: number; pnl: number }[] = [];
  for (let i = 0; i <= points; i++) {
    const spot = lo + ((hi - lo) * i) / points;
    const intrinsic = Math.max(0, q.strike - spot) * contracts; // put
    const pnl = youBuy ? intrinsic - q.premiumUsdc : q.premiumUsdc - intrinsic;
    out.push({ spot, pnl });
  }
  return out;
}
