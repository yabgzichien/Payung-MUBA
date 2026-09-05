export type Asset = 'ETH' | 'BTC';

export type Goal = {
  asset: Asset;
  quantity: number;
  /** Per-unit floor price in USD, e.g. 2300 means "$2,300 per ETH". */
  floorUsd: number;
  /** Total USD value the whole holding must retain — floorUsd * quantity. What the backend calls floorTotalUsd. */
  floorTotalUsd: number;
  days: number;
};

/** A message can also (or only) render a live, interactive component in the chat thread. */
export type ChatCardKind = 'quote-options' | 'confirm-summary' | 'connect-wallet' | 'review-execute' | 'purchased';

export type ChatMessage =
  | { from: 'you'; text: string }
  | { from: 'payung'; text?: string; card?: ChatCardKind };

export type FieldKey = 'asset' | 'quantity' | 'floor' | 'horizonDays';

export type ParseResult = {
  spec: {
    asset: Asset | null;
    quantity: number | null;
    unitFloorUsd: number | null;
    floorTotalUsd: number | null;
    horizonDays: number | null;
  };
  missingFields: FieldKey[];
  fieldErrors: Partial<Record<FieldKey, string>>;
  answer?: string;
};

export type Badge = {
  state: 'full' | 'surplus' | 'short' | 'far-from-floor';
  text: string;
  tone: 'good' | 'warn' | 'neutral';
};

export type WireCandidate = {
  id: string;
  strike: number;
  expiryIso: string;
  daysToExpiry: number;
  pricePerContract: number;
  iv: number | null;
  coverageGapDays: number;
  makerBudget: number;
  collateralSymbol: string | null;
  impliedStrike: number;
  pctVsImpliedStrike: number;
  pctFromImpliedStrike: number;
  coversFullHorizon: boolean;
  badge: Badge;
};

/**
 * A planning-only estimate for chaining several near-dated puts toward the
 * user's exact target when the book has no candidate that covers the full
 * horizon near the requested strike. anchorLeg is a real, live, fillable
 * order; estimatedTotalPremiumUsd is theoretical (Black-Scholes over the
 * anchor's own live IV) — never a live quote. See docs/superpowers/specs/
 * 2026-09-02-chained-roll-estimate-design.md.
 */
export type RollEstimate = {
  anchorLeg: WireCandidate;
  anchorPremiumUsd: number;
  estimatedLegs: number;
  estimatedTotalPremiumUsd: number;
  ivUsed: number;
  spotUsed: number;
};

export type CandidatesResponse = {
  candidates: WireCandidate[];
  coverage: {
    premiumDelta: number | null;
    gapDays: number | null;
    surplusDays: number | null;
    hasFullCover: boolean;
  };
  rollEstimate: RollEstimate | null;
};

/** RollEstimate plus a live quote for the anchor leg, so the UI can send it through the normal buy flow. */
export type RollEstimateCard = RollEstimate & { anchorQuote: QuoteCard };

export type PreciseCommitmentWire = {
  safe: string;
  active: boolean;
  spec: { asset: Asset; quantity: number; floorTotalUsd: number; horizonDays: number };
  spentUsd: number;
  totalSpendCapUsd: number;
  rollsUsed: number;
  maxRolls: number;
  currentLeg: ShapedPosition | null;
  history: { strike: number; expiryIso: string; premiumUsd: number; txHash: string }[];
};

export type PrepareOpenResponse = { to: string; data: string };

export type Judgment = {
  premiumPctOfProtection: number;
  verdict: 'reasonable' | 'expensive' | 'not-worth-it';
  reasons: string[];
};

export type QuoteResponse = {
  quote: {
    strike: number;
    expiryIso: string;
    requestedUsdc: number;
    spendUsdc: number;
    capped: boolean;
    premiumUsdc: number;
    pricePerContract: number;
    yourSide: string;
    contracts: number;
  };
  judgment: Judgment;
  payoff: { spot: number; pnl: number }[];
};

/** A candidate + its live quote, merged into what the UI displays as one "protection option". */
export type QuoteCard = {
  id: string;
  tier: 'recommended' | 'cheaper';
  floorUsd: number; // = strike
  coverageLabel: 'Full' | 'Partial';
  coverageDetail: string;
  costUsd: number; // = premiumUsdc
  contracts: number;
  expiryIso: string;
  expiryNote: string;
  note: string;
  protocol: string;
  network: string;
  collateralSymbol: string | null;
  judgment: Judgment;
  /** Payoff curve from /api/quote — what the position is worth at each settlement price. */
  payoff: { spot: number; pnl: number }[];
};

export type WalletState = {
  connected: boolean;
  address: string | null;
  chainOk: boolean;
};

export type AavePlan = {
  isAaveToken: true;
  aBasUsdcAddress: string;
  rawUsdcAddress: string;
  aavePoolAddress: string;
  supplyAmount: string;
  approveAaveTx: { to: string; data: string };
  supplyTx: { to: string; data: string };
};

export type PrepareTxResponse = {
  quote: {
    requestedUsdc: number;
    spendUsdc: number;
    capped: boolean;
    premiumUsdc: number;
    strike: number;
    expiryIso: string;
    yourSide: string;
  };
  collateralToken: string;
  collateralDecimals: number;
  collateralUnits: string;
  requiredCollateralUnits: string;
  contracts: number;
  optionBookAddress: string;
  approveOptionBookTx: { to: string; data: string };
  fillTx: { to: string; data: string };
  aavePlan: AavePlan | null;
};

export type PurchaseResult = {
  txHash: string;
  explorerUrl: string;
};

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
  expiryIso: string | null;
  daysToExpiry: number | null;
};
