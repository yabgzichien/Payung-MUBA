/**
 * The user's stated constraint, and the one derivation over it.
 *
 * This module deliberately has ZERO imports. `src/intent.ts` calls
 * `impliedStrike` at runtime, and HANDOFF.md's design rule 1 requires
 * intent.ts/judgment.ts to import only *types* from core.ts — putting this
 * in core.ts would force a value import that drags dotenv and the whole
 * Thetanuts SDK into the zero-network intent tests.
 */

export type ProtectionSpec = {
  /** 'ETH' | 'BTC' — what the user holds. */
  asset: 'ETH' | 'BTC';
  /** How much of the asset the user holds. */
  quantity: number;
  /** Total USD value the whole holding must be worth at the deadline. */
  floorTotalUsd: number;
  /** How long they need protection, in days. */
  horizonDays: number;
};

/**
 * The per-unit strike a total-value floor implies. This is the ONLY place
 * this division happens — filterCandidates, validateSpec, the CLI, and the
 * server all read this instead of recomputing it, so the per-unit and total
 * readings of a floor can never drift apart (see the design doc's Section 1a
 * regression: "$798 for 0.32 ETH" was previously matched as a $798 strike
 * instead of the correct $2,493.75).
 */
export function impliedStrike(spec: ProtectionSpec): number {
  return spec.floorTotalUsd / spec.quantity;
}

/**
 * The inverse of impliedStrike: a total holding value from a per-unit price.
 * Exists so a sentence stating a market/per-unit price (e.g. "BTC not below
 * $62,000") can be converted to floorTotalUsd in tested code — the NL parser
 * is forbidden from doing this multiplication itself (see intent.ts).
 */
export function totalFromUnit(unitFloorUsd: number, quantity: number): number {
  return unitFloorUsd * quantity;
}

/**
 * Whether a candidate's remaining window reaches the user's stated deadline.
 * The single shared definition of "covers the horizon" — rankCandidates,
 * coverageChoice, and badgeFor must all agree on this, or a candidate can be
 * ranked as short-dated while simultaneously being badged as full coverage.
 */
export function coversHorizon(daysToExpiry: number, horizonDays: number): boolean {
  return daysToExpiry >= horizonDays;
}
