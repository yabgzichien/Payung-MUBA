import { ethers } from 'ethers';

/**
 * Price history + spot for the UI's chart. Deliberately separate from
 * core.ts — a price oracle is not a Thetanuts concern (design rule: core.ts
 * is the only module that touches the Thetanuts SDK; this module must never
 * import it, not even as a type).
 *
 * Consequence for the API below: fetchSpot() takes a feed address and an
 * ethers.Provider as plain arguments rather than a ThetanutsClient. The
 * caller (server.ts) already holds a client and reads client.provider and
 * client.chainConfig.priceFeeds[asset] off it — both are public, typed
 * fields. Keeping those two values as parameters is what lets this module
 * stay SDK-free and independently testable.
 */

export type Candle = { t: number; o: number; h: number; l: number; c: number };

/**
 * Normalize Coinbase Exchange's raw candle rows.
 *
 * GOTCHA: Coinbase's documented row order is
 * [time, low, high, open, close, volume] — NOT [t, o, h, l, c]. Getting this
 * wrong silently swaps open/close and high/low on every candle. This
 * function is the one place that ordering is handled, tested in isolation,
 * so no caller has to remember it.
 */
export function toCandles(rawRows: number[][]): Candle[] {
  const out: Candle[] = [];
  for (const row of rawRows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, low, high, open, close] = row;
    out.push({ t, o: open, h: high, l: low, c: close });
  }
  return out;
}

const COINBASE_PRODUCT: Record<'ETH' | 'BTC', string> = { ETH: 'ETH-USD', BTC: 'BTC-USD' };

/** Granularities Coinbase Exchange accepts, in seconds. Anything else is a 400. */
const COINBASE_GRANULARITIES = [60, 300, 900, 3600, 21600, 86400];

/** Coinbase caps ONE request at 300 candles, regardless of granularity. */
const COINBASE_MAX_CANDLES = 300;

/**
 * Smallest accepted granularity that keeps `days` of history under Coinbase's
 * 300-candle-per-request cap.
 *
 * GOTCHA (confirmed against the live API, not inferred): exceeding the cap is
 * a hard `400 {"message":"granularity too small for the requested time range.
 * Count of aggregations requested exceeds 300"}`, not a truncated response. A
 * fixed if/else ladder gets this wrong at both ends of the 1-90 day range the
 * horizon field allows — 2 days at 5m granularity is 576 candles (400), and
 * 90 days at 6h is 360 candles (400). Deriving the granularity from the cap
 * is the only version that holds across the whole range.
 */
export function granularityFor(days: number): number {
  const minSecondsPerCandle = (days * 86400) / COINBASE_MAX_CANDLES;
  return COINBASE_GRANULARITIES.find((g) => g >= minSecondsPerCandle) ?? 86400;
}

/**
 * Real OHLC history from Coinbase Exchange's public candles endpoint. No API
 * key required.
 *
 * THROWS on a failed fetch rather than returning [] — the caller must be able
 * to tell "the market genuinely has no candles here" from "the request
 * failed", because the UI states which one happened. server.ts's /api/history
 * route catches this, degrades to spot-only, and reports historyError; the
 * chart is an enhancement and never gates the trading flow.
 */
export async function fetchHistory(asset: 'ETH' | 'BTC', days: number): Promise<Candle[]> {
  const product = COINBASE_PRODUCT[asset];
  const granularity = granularityFor(days);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400 * 1000);
  const url = `https://api.exchange.coinbase.com/products/${product}/candles` +
    `?start=${start.toISOString()}&end=${end.toISOString()}&granularity=${granularity}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'payung' } });
  if (!res.ok) throw new Error(`Coinbase candles ${res.status}: ${await res.text()}`);
  const rows: number[][] = await res.json();
  return toCandles(rows).sort((a, b) => a.t - b.t);
}

const AGGREGATOR_V3_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
];

/**
 * A feed's `decimals()` is immutable for the life of the contract, so it is
 * read once per address and cached forever. This is not a micro-optimisation:
 * it halves the RPC calls per spot read, and the public Base RPC's rate limit
 * is what makes spot reads fail (see fetchSpot).
 */
const _feedDecimals = new Map<string, number>();

/** Backoff between spot retries, in ms. Immediate retries just hit the same rate-limit window. */
const SPOT_RETRY_DELAYS_MS = [200, 600, 1500];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Live spot from the SAME Chainlink feed a candidate's option actually
 * settles against — the caller passes chainConfig.priceFeeds[asset], the
 * identical feed findCandidates() matches candidates on in core.ts. This is
 * deliberate: the spot marker on the chart must be the settlement price,
 * not a different exchange's idea of "current price".
 *
 * Takes (feed, provider) rather than a ThetanutsClient so this module stays
 * SDK-free (design rule 1) and testable against a stub provider.
 *
 * RETRY POLICY, and why it is this aggressive: the default `BASE_RPC_URL`
 * (https://mainnet.base.org) rate-limits hard under even light sequential
 * load, failing with "missing revert data" on a call that succeeded moments
 * earlier. Measured against the live endpoint, a single immediate retry left
 * a ~58% failure rate — the chart lost its headline number more often than it
 * showed it. Caching decimals() (halving the calls) plus three retries with
 * growing backoff is what makes this reliable. A persistent failure still
 * surfaces to the caller, which degrades to spot-unavailable and says so on
 * screen rather than inventing a price.
 *
 * The real fix for a demo is a dedicated RPC (see docs/demo-runbook.md);
 * this makes the public endpoint survivable, it does not make it good.
 */
export async function fetchSpot(
  feed: string,
  provider: ethers.Provider
): Promise<{ price: number; updatedAt: string; feed: string }> {
  if (!feed) throw new Error('No price feed address supplied');
  const key = feed.toLowerCase();
  const aggregator = new ethers.Contract(feed, AGGREGATOR_V3_ABI, provider);

  const read = async () => {
    if (!_feedDecimals.has(key)) {
      _feedDecimals.set(key, Number(await aggregator.decimals()));
    }
    const decimals = _feedDecimals.get(key)!;
    const round = await aggregator.latestRoundData();
    const price = Number(round.answer) / 10 ** decimals;
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Feed ${feed} returned an unusable answer: ${round.answer}`);
    }
    return {
      price,
      updatedAt: new Date(Number(round.updatedAt) * 1000).toISOString(),
      feed: key,
    };
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= SPOT_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(SPOT_RETRY_DELAYS_MS[attempt - 1]);
    try {
      return await read();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
