import { quote, assertFillable, simulate } from '@/src/core';
import {
  getCached, jsonResponse, parseSpend, requireJsonContentType,
  serverSigningAllowed, SERVER_SIGNING_REFUSAL, withErrorHandling,
} from '@/src/api-shared';

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    // Uses the server's PRIVATE_KEY (callStaticFillOrder needs a signer
    // address). Read-only, but gated with /api/execute so there is exactly one
    // rule for "routes that touch the server wallet" — see serverSigningAllowed.
    if (!serverSigningAllowed()) return jsonResponse(403, { error: SERVER_SIGNING_REFUSAL });
    const { id, spendUsdc } = await req.json();
    const { candidate } = getCached(String(id));
    const q = await quote(candidate, parseSpend(spendUsdc));
    try {
      assertFillable(candidate, Math.floor(Date.now() / 1000));
      if (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY !== '0x') {
        const sim = await simulate(candidate, q.spendUsdc);
        return jsonResponse(200, { ok: sim.ok, error: sim.error });
      }
      return jsonResponse(200, { ok: true });
    } catch (e: any) {
      return jsonResponse(200, { ok: false, error: e?.message || String(e) });
    }
  });
}
