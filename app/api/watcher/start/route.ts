import type { RollPolicy } from '@/src/policy';
import { start } from '@/src/watcher-runtime';
import {
  jsonResponse, requireJsonContentType, serverSigningAllowed, SERVER_SIGNING_REFUSAL,
  watcherLoopAllowed, WATCHER_LOOP_REFUSAL, withErrorHandling,
} from '@/src/api-shared';

/**
 * No field here ever falls back to a server-side default — the caller (the
 * policy form) is expected to always send a complete policy, same "never
 * silently configured" guarantee the CLI's --auto flag enforces. Missing or
 * non-numeric fields become NaN, which validatePolicy (inside start()) rejects.
 */
function readPolicy(raw: any): RollPolicy {
  return {
    rollWhenDaysToExpiry: Number(raw?.rollWhenDaysToExpiry),
    minDeadlineDaysLeft: Number(raw?.minDeadlineDaysLeft),
    maxPremiumUsd: Number(raw?.maxPremiumUsd),
    maxRolls: Number(raw?.maxRolls),
    assets: Array.isArray(raw?.assets) ? raw.assets : [],
  };
}

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    if (!watcherLoopAllowed()) return jsonResponse(403, { error: WATCHER_LOOP_REFUSAL });

    const body = await req.json();
    const auto = body?.auto === true;
    // Auto mode can execute real fills every cycle — the same money-movement
    // gate /api/execute already uses, checked before the loop is even armed.
    if (auto && !serverSigningAllowed()) return jsonResponse(403, { error: SERVER_SIGNING_REFUSAL });

    const policy = readPolicy(body?.policy);
    const errs = start({ auto, policy });
    if (errs.length) return jsonResponse(400, { error: errs.join('; ') });
    return jsonResponse(200, { started: true });
  });
}
