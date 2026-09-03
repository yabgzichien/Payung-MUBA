import { coverageChoice, estimateRoll, findCandidates, readClient, type ProtectionSpec } from '@/src/core';
import { validateSpec } from '@/src/intent';
import { fetchSpot } from '@/src/spot';
import {
  ClientError, candidateId, HISTORY_CACHE_MS, jsonResponse, rememberCandidates, requireJsonContentType,
  spotCache, toRollEstimateWire, toWire, withErrorHandling,
} from '@/src/api-shared';

/**
 * Best-effort live spot, reusing the same cache app/api/history/route.ts
 * writes to. A failed read degrades rollEstimate to null (Invariant 2) — it
 * must never fail the whole candidates response, which is the trading flow.
 */
async function spotForRollEstimate(spec: ProtectionSpec, client: ReturnType<typeof readClient>): Promise<number | null> {
  const cached = spotCache.get(spec.asset);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_MS) return cached.spot.price;
  try {
    const feed = client.chainConfig.priceFeeds[spec.asset];
    if (!feed) return null;
    const spot = await fetchSpot(feed, client.provider);
    spotCache.set(spec.asset, { spot, fetchedAt: Date.now() });
    return spot.price;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    const body = await req.json();
    let spec: ProtectionSpec;
    try {
      spec = validateSpec(body.spec);
    } catch (e: any) {
      // validateSpec's own throws are about a malformed client-supplied spec,
      // never a server/RPC problem — re-tag so the caller gets 400, not 500.
      throw new ClientError(e?.message ?? String(e));
    }
    const client = readClient();
    const candidates = await findCandidates(spec, client);
    // Additive, never a wipe — another tab (or another user) may be mid-purchase
    // against a candidate from an earlier search. See rememberCandidates().
    rememberCandidates(candidates.map((c) => ({ id: candidateId(c), candidate: c, spec })));
    const choice = coverageChoice(candidates, spec);

    const spotPrice = await spotForRollEstimate(spec, client);
    const rollEstimate = spotPrice !== null ? estimateRoll(candidates, spec, spotPrice) : null;

    return jsonResponse(200, {
      candidates: candidates.map((c, i) => toWire(c, spec, i === 0)),
      coverage: {
        premiumDelta: choice.premiumDelta,
        gapDays: choice.gapDays,
        surplusDays: choice.surplusDays,
        hasFullCover: choice.best !== null,
      },
      rollEstimate: rollEstimate ? toRollEstimateWire(rollEstimate, spec) : null,
    });
  });
}
