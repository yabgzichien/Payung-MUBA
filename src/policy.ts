/**
 * The roll decision. Pure — no network, no signing, no side effects.
 *
 * One function decides; two thin modes act on it (notify by default, --auto
 * when explicitly configured). That is what lets the safe default and the
 * autonomous mode share a single tested decision path.
 *
 * Trigger scope is deliberately narrow: expiry-approaching only. Spot-relative
 * and cheaper-order triggers are out of scope (see the spec).
 */
import { deadlineDaysLeft, type Commitment } from './commitments';
import type { ShapedPosition } from './positions';

export type RollPolicy = {
  /** Roll when the position has this many days or fewer left. */
  rollWhenDaysToExpiry: number;
  /** Do not roll if the user's own deadline is this close or already passed. */
  minDeadlineDaysLeft: number;
  /** Hard cap on premium for a single roll, in USD. */
  maxPremiumUsd: number;
  /** Hard cap on rolls per commitment. */
  maxRolls: number;
  assets: ('ETH' | 'BTC')[];
};

export type RollDecision =
  | { action: 'none'; reason: string }
  | { action: 'roll'; reason: string; remainingDays: number; deadlineDaysLeft: number }
  | { action: 'blocked'; reason: string };

/** Conservative defaults for notify mode. --auto refuses to use them implicitly. */
export const DEFAULT_POLICY: RollPolicy = {
  rollWhenDaysToExpiry: 2,
  minDeadlineDaysLeft: 1,
  maxPremiumUsd: 25,
  maxRolls: 3,
  assets: ['ETH', 'BTC'],
};

export function decideRoll(
  position: ShapedPosition, commitment: Commitment, now: Date, policy: RollPolicy
): RollDecision {
  if (position.status !== 'active') {
    return { action: 'none', reason: `Position is ${position.status ?? 'unknown'}, not active.` };
  }

  const remainingDays = position.daysToExpiry ?? Infinity;
  if (remainingDays > policy.rollWhenDaysToExpiry) {
    return { action: 'none', reason: `${remainingDays.toFixed(1)}d to expiry, above the ${policy.rollWhenDaysToExpiry}d trigger.` };
  }

  const left = deadlineDaysLeft(commitment, now);
  if (left <= policy.minDeadlineDaysLeft) {
    return { action: 'none', reason: `The user's deadline is ${left.toFixed(1)}d away — protection is no longer needed.` };
  }

  // Below here a roll IS needed. Anything that stops it is 'blocked', never
  // 'none': the user must learn that action was required and policy forbade it.
  if (!policy.assets.includes(commitment.spec.asset)) {
    return { action: 'blocked', reason: `${commitment.spec.asset} is not in the policy asset allowlist.` };
  }
  if (commitment.rollsUsed >= policy.maxRolls) {
    return { action: 'blocked', reason: `roll limit reached (${commitment.rollsUsed}/${policy.maxRolls}).` };
  }

  return {
    action: 'roll',
    reason: `${remainingDays.toFixed(1)}d to expiry but ${left.toFixed(1)}d still to the deadline.`,
    remainingDays,
    deadlineDaysLeft: left,
  };
}

/** Every field must be present and sane. --auto must never start half-configured. */
export function validatePolicy(p: Partial<RollPolicy>): string[] {
  const errs: string[] = [];
  const positive = (k: keyof RollPolicy) => {
    const v = p[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) errs.push(`${k} must be a positive number`);
  };
  positive('rollWhenDaysToExpiry');
  positive('maxPremiumUsd');
  positive('maxRolls');
  if (typeof p.minDeadlineDaysLeft !== 'number' || !Number.isFinite(p.minDeadlineDaysLeft) || p.minDeadlineDaysLeft < 0) {
    errs.push('minDeadlineDaysLeft must be zero or a positive number');
  }
  if (!Array.isArray(p.assets) || p.assets.length === 0) errs.push('assets must list at least one asset');
  return errs;
}
