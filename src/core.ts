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
const _decCache = new Map<string, number>();
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

export type ProtectionSpec = {
  /** 'ETH' | 'BTC' — what the user holds. */
  asset: 'ETH' | 'BTC';
  /** The floor the user wants under their asset, in USD. */
  floorUsd: number;
  /** How long they need protection, in days. */
  horizonDays: number;
};

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

/**
 * How many days short of the user's stated deadline this option's protection
 * ends. > 0 means the floor evaporates BEFORE the date the user asked for —
 * allowed, but it must be surfaced loudly, never silently (FR/audit attack 4).
 */
export function coverageGapDays(c: Candidate, spec: ProtectionSpec): number {
  return Math.max(0, spec.horizonDays - c.daysToExpiry);
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

/**
 * Price a fill. Synchronous SDK call — this is the SDK's own collateral math,
 * which is why the docs warn that for puts and spreads
 * "contract count is NOT the same as premium".
 */
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

/**
 * Simulate the REAL transaction without spending anything.
 *
 * This is the most useful call in the whole SDK for you: it runs the actual
 * fill against current chain state and reverts if it would fail. Build the
 * entire product against this. Spend real money once, on camera.
 */
export async function simulate(
  candidate: Candidate,
  collateralUsdc: number,
  client = writeClient()
): Promise<{ ok: boolean; result?: any; error?: string }> {
  const amount = BigInt(Math.round(collateralUsdc * 10 ** USDC_DECIMALS));
  try {
    const result = await client.optionBook.callStaticFillOrder(candidate.raw, amount);
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

  // CRITICAL: fillOrder() has already landed on-chain at this point. Everything
  // below is best-effort bookkeeping ("what did we pay?"), never grounds to
  // throw — a throw here would tell the caller the fill failed when in fact a
  // real, irreversible on-chain transaction just succeeded, inviting a
  // duplicate real-money retry. If we can't determine the paid amount, we
  // report it as unknown (paidUsd: null) rather than as an error.
  const me = await client.getSignerAddress();
  const dec = await collateralDecimals(client, candidate.collateralToken);
  const paidUnits = sumDebits(rec?.logs ?? [], candidate.collateralToken, me);
  return {
    hash,
    explorer: `https://basescan.org/tx/${hash}`,
    receipt,
    paidUnits,
    paidUsd: paidUnits === 0n ? null : Number(paidUnits) / 10 ** dec,
  };
}

/** Payoff curve for the UI. Pure math — no network, no LLM. */
export function payoffCurve(q: Quote, spotRange: [number, number], points = 60) {
  const [lo, hi] = spotRange;
  const contracts = q.collateralUsdc / q.strike;
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
