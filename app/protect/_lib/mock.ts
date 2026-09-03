/**
 * Starter prompts. These are the very first thing most users tap, so they must
 * land on inventory the book actually carries — the previous first example
 * ("Protect 0.2 ETH at $2,300 for 7 days") resolved to zero candidates against
 * the live book and dead-ended every new user on their first interaction. Sizes
 * of 1 unit and horizons of two weeks or more match the strikes and expiries
 * Thetanuts quotes in practice; the Results empty state now offers a real
 * recovery path for whenever the book moves away from these anyway.
 */
export const EXAMPLE_PROMPTS = [
  'Keep 1 ETH above $2,200 for 2 weeks',
  'Protect 2 ETH at a $2,300 protected price for 30 days',
];

/** Three preset floors around a base floor, for the "explore protection" screen. */
export function buildExploreFloors(baseFloorUsd: number): number[] {
  const step = Math.max(25, Math.round(baseFloorUsd * 0.04));
  return [baseFloorUsd - step, baseFloorUsd, baseFloorUsd + step];
}
