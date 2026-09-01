/**
 * Pure display decisions, shared by the web UI and the CLI.
 *
 * Badge logic used to live inline in public/app.js, where it could not be
 * tested — and where `EXACT MATCH` was set from strike distance ALONE while
 * reading to a user as "exactly what you asked for". A badge must state both
 * dimensions of the request: the floor and the deadline.
 */
import { impliedStrike, coversHorizon, type ProtectionSpec } from './spec';
import type { Candidate } from './core.js'; // type-only: no runtime SDK import

export type CoverageState = 'full' | 'surplus' | 'short' | 'far-from-floor';
export type Badge = { state: CoverageState; text: string; tone: 'good' | 'warn' | 'neutral' };

/** Beyond this distance from the implied floor, a match is called far, not close. */
export const CLOSEST_MATCH_MAX_PCT = 5;

export function badgeFor(c: Candidate, spec: ProtectionSpec, isTopPick: boolean): Badge {
  const target = impliedStrike(spec);
  const pctVs = ((target - c.strike) / target) * 100;
  const dist = Math.abs(pctVs);
  const sign = pctVs >= 0 ? '−' : '+';
  const floorPart = dist < 0.01 ? 'EXACT FLOOR' : `${sign}${dist.toFixed(1)}% FLOOR`;

  // Coverage is decided BEFORE strike proximity: a floor that evaporates early
  // is a worse defect than a floor a fraction of a percent off.
  const gap = spec.horizonDays - c.daysToExpiry;
  if (!coversHorizon(c.daysToExpiry, spec.horizonDays)) {
    return { state: 'short', tone: 'warn', text: `${gap.toFixed(1)} DAYS SHORT · ${floorPart}` };
  }

  if (dist > CLOSEST_MATCH_MAX_PCT) {
    return {
      state: 'far-from-floor',
      tone: 'warn',
      text: `FAR FROM YOUR FLOOR · ${sign}${dist.toFixed(1)}%`,
    };
  }

  if (!isTopPick) {
    return { state: gap < -0.05 ? 'surplus' : 'full', tone: 'neutral', text: `YOUR PICK · ${floorPart}` };
  }

  return {
    state: gap < -0.05 ? 'surplus' : 'full',
    tone: 'good',
    text: `FULL COVER · ${floorPart}`,
  };
}
