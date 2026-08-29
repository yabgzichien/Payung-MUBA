import { findCandidates, type ProtectionSpec } from '@/src/core';
import { validateSpec } from '@/src/intent';
import {
  ClientError, cache, candidateId, jsonResponse, requireJsonContentType, toWire, withErrorHandling,
} from '@/src/api-shared';

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
    const candidates = await findCandidates(spec);
    cache.clear();
    for (const c of candidates) cache.set(candidateId(c), { candidate: c, spec, fetchedAt: Date.now() });
    return jsonResponse(200, { candidates: candidates.map((c) => toWire(c, spec)) });
  });
}
