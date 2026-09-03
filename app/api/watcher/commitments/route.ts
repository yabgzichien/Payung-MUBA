import type { NextRequest } from 'next/server';
import { readCommitments } from '@/src/commitments';
import { DEFAULT_POLICY, type RollPolicy } from '@/src/policy';
import { evaluateCommitment, positionsFor } from '@/src/watcher';
import { getSignerAddress } from '@/src/watcher-runtime';
import { jsonResponse, withErrorHandling } from '@/src/api-shared';

/**
 * Read-only preview: what WOULD happen to each stored commitment under the
 * given policy, right now — no execution, no audit-log writes. Query params
 * default to DEFAULT_POLICY (safe here since nothing spends), letting the
 * page render before the user has touched the policy form.
 */
function policyFromParams(params: URLSearchParams): RollPolicy {
  const assets = params.get('assets');
  return {
    rollWhenDaysToExpiry: Number(params.get('rollWhenDaysToExpiry') ?? DEFAULT_POLICY.rollWhenDaysToExpiry),
    minDeadlineDaysLeft: Number(params.get('minDeadlineDaysLeft') ?? DEFAULT_POLICY.minDeadlineDaysLeft),
    maxPremiumUsd: Number(params.get('maxPremiumUsd') ?? DEFAULT_POLICY.maxPremiumUsd),
    maxRolls: Number(params.get('maxRolls') ?? DEFAULT_POLICY.maxRolls),
    assets: assets ? (assets.split(',') as RollPolicy['assets']) : DEFAULT_POLICY.assets,
  };
}

export async function GET(req: NextRequest) {
  return withErrorHandling(async () => {
    const policy = policyFromParams(req.nextUrl.searchParams);
    const address = getSignerAddress();
    const now = new Date();
    const commitments = readCommitments();
    const positions = await positionsFor(address, Math.floor(now.getTime() / 1000));
    const evaluations = await Promise.all(commitments.map((c) => evaluateCommitment(c, positions, now, policy)));

    return jsonResponse(200, {
      address,
      rows: evaluations.map((e) => ({
        txHash: e.commitment.txHash,
        asset: e.commitment.spec.asset,
        strike: e.commitment.strike,
        expiryIso: e.commitment.expiryIso,
        deadlineIso: e.commitment.deadlineIso,
        rollsUsed: e.commitment.rollsUsed,
        hasPosition: e.position !== null,
        positionStatus: e.position?.status ?? null,
        daysToExpiry: e.position?.daysToExpiry ?? null,
        action: e.decision?.action ?? null,
        reason: e.decision?.reason ?? null,
        replacement: e.replacement
          ? {
              strike: e.replacement.candidate.strike,
              expiryIso: e.replacement.candidate.expiry.toISOString(),
              premiumUsd: e.replacement.premiumUsd,
            }
          : null,
        overCap: e.overCap,
      })),
    });
  });
}
