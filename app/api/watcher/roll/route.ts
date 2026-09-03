import { readCommitments, deadlineDaysLeft } from '@/src/commitments';
import { DEFAULT_POLICY, decideRoll, type RollDecision } from '@/src/policy';
import { appendAudit, executeRoll, findReplacement, positionsFor } from '@/src/watcher';
import { getSignerAddress } from '@/src/watcher-runtime';
import {
  ClientError, jsonResponse, requireJsonContentType, serverSigningAllowed, SERVER_SIGNING_REFUSAL,
  withErrorHandling,
} from '@/src/api-shared';

/**
 * A human-approved roll for one commitment — the GUI equivalent of the
 * notify-mode alert's suggested `npm run execute -- ...` command. Two calls:
 * confirm absent/false re-quotes fresh and returns it for display only (no
 * chain writes); confirm:true simulates-then-executes, same sequence as the
 * --auto branch (executeRoll), just human-triggered. No policy gate here —
 * same as the CLI's manual execute path, this is the human overriding
 * whatever the automated policy would have decided.
 */
export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    const { txHash, confirm } = await req.json();
    if (typeof txHash !== 'string' || !txHash) throw new ClientError('txHash is required');

    const commitment = readCommitments().find((c) => c.txHash === txHash);
    if (!commitment) throw new ClientError('Unknown commitment — no record with that txHash.');

    const now = new Date();
    const daysLeft = deadlineDaysLeft(commitment, now);
    if (daysLeft <= 0) throw new ClientError("This commitment's own deadline has already passed — nothing to protect.");

    const replacement = await findReplacement(commitment, now);
    if (!replacement) throw new ClientError('Nothing on the live book can replace this position right now.');

    if (confirm !== true) {
      return jsonResponse(200, {
        preview: true,
        strike: replacement.candidate.strike,
        expiryIso: replacement.candidate.expiry.toISOString(),
        premiumUsd: replacement.premiumUsd,
      });
    }

    // MUST come before spending anything — same gate /api/execute uses.
    if (!serverSigningAllowed()) return jsonResponse(403, { error: SERVER_SIGNING_REFUSAL });

    // Best-effort context for the audit log only — never gates the roll itself.
    const address = getSignerAddress();
    const positions = await positionsFor(address, Math.floor(now.getTime() / 1000));
    const position = positions.find(
      (x) => x.entryTxHash === commitment.txHash || x.optionAddress?.toLowerCase() === commitment.optionAddress.toLowerCase()
    ) ?? null;
    const decision: RollDecision = position
      ? decideRoll(position, commitment, now, DEFAULT_POLICY)
      : { action: 'roll', reason: 'manual approval via GUI — no live position match found', remainingDays: NaN, deadlineDaysLeft: daysLeft };

    const receipt = await executeRoll(commitment, replacement);
    appendAudit({
      at: now.toISOString(),
      positionId: position?.id ?? null,
      txHash: commitment.txHash,
      decision,
      policy: DEFAULT_POLICY,
      replacement: {
        strike: replacement.candidate.strike,
        expiryIso: replacement.candidate.expiry.toISOString(),
        premiumUsd: replacement.premiumUsd,
      },
      simulated: true,
      executedTxHash: receipt.hash,
      note: 'manual approval — executed via GUI',
    });

    return jsonResponse(200, { hash: receipt.hash, explorer: receipt.explorer, paidUsd: receipt.paidUsd });
  });
}
