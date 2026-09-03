/**
 * Standard European put pricing (Black-Scholes-Merton), no dependencies.
 *
 * Kept separate from core.ts (pure math, testable against known reference
 * values independent of any live data) — see docs/superpowers/specs/
 * 2026-09-02-chained-roll-estimate-design.md section 4.3.
 */

/** Abramowitz & Stegun 7.1.26 approximation, max error ~1.5e-7 — accurate enough for a premium estimate. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * European put price. spot/strike in the same currency, tYears in years,
 * r the risk-free rate, iv the annualized implied volatility (e.g. 0.55).
 */
export function bsPut(spot: number, strike: number, tYears: number, r: number, iv: number): number {
  const d1 = (Math.log(spot / strike) + (r + (iv * iv) / 2) * tYears) / (iv * Math.sqrt(tYears));
  const d2 = d1 - iv * Math.sqrt(tYears);
  return strike * Math.exp(-r * tYears) * normCdf(-d2) - spot * normCdf(-d1);
}

/**
 * Solve for Black-Scholes implied volatility of a European put using bisection.
 * Returns null if no solution in range [0.001, 5.00] or input invalid.
 */
export function impliedVolPut(
  spot: number,
  strike: number,
  tYears: number,
  r: number,
  targetPrice: number
): number | null {
  if (targetPrice <= 0 || spot <= 0 || strike <= 0 || tYears <= 0) return null;
  const intrinsic = Math.max(0, strike * Math.exp(-r * tYears) - spot);
  if (targetPrice < intrinsic) return null;

  let low = 0.001;
  let high = 5.0;
  if (bsPut(spot, strike, tYears, r, low) > targetPrice) return low;
  if (bsPut(spot, strike, tYears, r, high) < targetPrice) return high;

  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    const p = bsPut(spot, strike, tYears, r, mid);
    if (Math.abs(p - targetPrice) < 0.0001) return mid;
    if (p < targetPrice) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

