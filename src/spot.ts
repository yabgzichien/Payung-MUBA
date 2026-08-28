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
