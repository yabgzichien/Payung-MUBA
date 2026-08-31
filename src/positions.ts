/**
 * Position shaping, extracted from app/api/positions/route.ts so the route,
 * the list_positions tool, and the watcher share ONE definition.
 *
 * Decimal constants are redeclared rather than imported from core.ts: a value
 * import of core.ts pulls dotenv and the Thetanuts SDK into this module, and
 * this module must stay unit-testable with no network (HANDOFF.md rule 1).
 * They are asserted against core.ts's values in tests/positions-shape.test.ts.
 */
const STRIKE_DECIMALS = 8;
const USDC_DECIMALS = 6;

export type ShapedPosition = {
  id: string;
  optionAddress: string | null;
  underlying: string | null;
  strike: number | null;
  contracts: number | null;
  premiumPaid: number | null;
  collateralAmount: number | null;
  collateralSymbol: string | null;
  pnlUsd: number | null;
  status: string | null;
  exercised: boolean | null;
  entryTimestamp: number | null;
  entryTxHash: string | null;
  entryExplorer: string | null;
  expiryTimestamp: number | null;
  // Not in the brief's literal type block, but present in the route's actual
  // response and consumed by app/history/HistoryClient.tsx — dropping it
  // would violate Step 6's "unchanged apart from daysToExpiry" contract.
  expiryIso: string | null;
  /** Days from the caller's clock to expiry. Negative once expired. */
  daysToExpiry: number | null;
};

/**
 * The indexer returns tx hashes WITHOUT the 0x prefix (verified against 5817
 * live records: 0 prefixed, 5817 bare). Pasting a bare hash into a BaseScan
 * URL yields a broken link, so normalize here — the one place that builds
 * both the link and the displayed hash.
 */
export function normalizeHash(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const hex = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return `0x${hex.toLowerCase()}`;
}

const BASESCAN_TX = (hash: string) => `https://basescan.org/tx/${hash}`;

function toNum(v: unknown, scale = 1): number | null {
  if (v === undefined || v === null) return null;
  return Number(v) / scale;
}

export function shapeProtection(p: any, nowSec: number): ShapedPosition {
  const strikeRaw = Array.isArray(p.option?.strikes) && p.option.strikes.length > 0
    ? p.option.strikes[0]
    : Array.isArray(p.strikes) && p.strikes.length > 0
    ? p.strikes[0]
    : undefined;
  const expirySec = Number(p.option?.expiry ?? p.expiryTimestamp ?? 0) || null;
  const entrySec = p.entryTimestamp !== undefined ? Number(p.entryTimestamp) : null;
  const dec = Number(p.collateralDecimals ?? USDC_DECIMALS);
  const entryTxHash = normalizeHash(p.entryTxHash);
  return {
    id: String(p.id),
    optionAddress: p.optionAddress,
    underlying: p.option?.underlying ?? p.underlyingAsset ?? null,
    strike: toNum(strikeRaw, 10 ** STRIKE_DECIMALS),
    contracts: toNum(p.amount ?? p.numContracts, 10 ** USDC_DECIMALS),
    /**
     * The indexer's `entryPrice` is the on-chain OrderFilled `premiumAmount`
     * — the TOTAL premium paid, in collateral units (verified by decoding
     * tx 0xc15c6710…: indexer 12081192 === event premiumAmount 12081192,
     * i.e. $12.08 at 6dp). It is NOT per-contract and NOT the order book's
     * 1e8 price scale; dividing by that scale reported it 100x too small.
     */
    premiumPaid: toNum(p.entryPrice ?? p.entryPremium, 10 ** dec),
    collateralAmount: toNum(p.collateralAmount, 10 ** dec),
    collateralSymbol: p.collateralSymbol ?? null,
    pnlUsd: p.pnlUsd != null ? Number(p.pnlUsd) / 1e8 : null,
    // 'active' | 'closed' | 'expired-awaiting-settlement' | 'settled-itm' | 'settled-otm', falls back to the coarser field.
    status: p.optionStatus ?? p.status ?? null,
    exercised: p.settlement?.exercised ?? null,
    entryTimestamp: entrySec,
    entryTxHash,
    entryExplorer: entryTxHash ? BASESCAN_TX(entryTxHash) : null,
    expiryTimestamp: expirySec,
    expiryIso: expirySec ? new Date(expirySec * 1000).toISOString() : null,
    daysToExpiry: expirySec ? (expirySec - nowSec) / 86_400 : null,
  };
}
