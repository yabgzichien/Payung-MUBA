import type { RollPolicy } from '@/src/policy';
import { runOnce } from '@/src/watcher-runtime';
import {
  jsonResponse, requireJsonContentType, serverSigningAllowed, SERVER_SIGNING_REFUSAL, withErrorHandling,
} from '@/src/api-shared';

/** Same "never a silent default" rule as /start — see that route's readPolicy comment. */
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
    const body = await req.json();
    const auto = body?.auto === true;
    // A single cycle run right now, not a persistent loop — no watcherLoopAllowed
    // gate needed, but auto can still execute a real fill this cycle.
    if (auto && !serverSigningAllowed()) return jsonResponse(403, { error: SERVER_SIGNING_REFUSAL });

    const policy = readPolicy(body?.policy);
    const report = await runOnce({ auto, policy });
    return jsonResponse(200, { report });
  });
}
