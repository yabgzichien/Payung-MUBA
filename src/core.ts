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

/** Signing client. Only needed for `execute()`. Requires PRIVATE_KEY. */
export function writeClient() {
  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  );
  const pk = process.env.PRIVATE_KEY;
  if (!pk || pk === '0x') {
    throw new Error('PRIVATE_KEY missing. Copy .env.example to .env. BURNER WALLET ONLY.');
  }
  const signer = new ethers.Wallet(pk, provider);
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

/**
 * Translate a human constraint into candidate structures.
 *
 * This is the function the LLM calls. It does NOT invent anything — it filters
 * the live book. If it returns [], there is genuinely nothing fillable that
 * matches, and the agent must say so rather than improvise.
 */
export async function findCandidates(
  spec: ProtectionSpec,
  client = readClient()
): Promise<Candidate[]> {
  const book = await getBook(client);
  const usdc = client.chainConfig.tokens.USDC.address.toLowerCase();

  // A floor under a long asset position is a PUT. This is not a judgement call
  // or a prediction — it is the correct instrument for the stated constraint.
  return book
    .filter((c) => !c.isCall)
    // CRITICAL: to BUY protection you need a maker who is SELLING. Only ~20% of
    // the book qualifies. Without this filter you would be writing naked puts —
    // the exact opposite of protection, with unbounded-feeling risk.
    .filter((c) => !c.makerIsBuyer)
    // Keep it to USDC collateral so premiums are denominated in dollars.
    .filter((c) => c.collateralToken.toLowerCase() === usdc)
    .filter((c) => c.daysToExpiry >= spec.horizonDays * 0.6)
    .filter((c) => c.daysToExpiry <= spec.horizonDays * 2.5)
    // Prefer strikes near the requested floor.
    .sort(
      (a, b) =>
        Math.abs(a.strike - spec.floorUsd) - Math.abs(b.strike - spec.floorUsd)
    )
    .slice(0, 8);
}

export type Quote = {
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
  collateralUsdc: number,
  client = readClient()
): Promise<Quote> {
  const amount = BigInt(Math.round(collateralUsdc * 10 ** USDC_DECIMALS));
  const preview: any = client.optionBook.previewFillOrder(candidate.raw, amount);
  const scale = await priceScale(client);

  const pricePerContract = Number(preview.pricePerContract) / scale;
  // numContracts is scaled such that, for a cash-secured put,
  // collateral ≈ strike × contracts. Derive contracts from that identity
  // rather than assuming a decimal count.
  const contracts = Number(preview.totalCollateral) / 10 ** USDC_DECIMALS / candidate.strike;

  return {
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
  collateralUsdc: number,
  client = writeClient()
): Promise<{ hash: string; explorer: string; receipt: any }> {
  const amount = BigInt(Math.round(collateralUsdc * 10 ** USDC_DECIMALS));

  // Fail loudly before spending gas if the fill would revert.
  const sim = await simulate(candidate, collateralUsdc, client);
  if (!sim.ok) throw new Error(`Simulation failed, refusing to send: ${sim.error}`);

  // Approve THIS order's collateral token, not a hardcoded USDC address.
  await client.erc20.ensureAllowance(
    candidate.collateralToken,
    client.chainConfig.contracts.optionBook,
    amount
  );

  const receipt: any = await client.optionBook.fillOrder(candidate.raw, amount);
  const hash = receipt?.hash ?? receipt?.transactionHash ?? String(receipt);
  return { hash, explorer: `https://basescan.org/tx/${hash}`, receipt };
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
