import { quote, coverageGapDays, payoffCurve } from '@/src/core';
import { judgeQuote } from '@/src/judgment';
import { getCached, jsonResponse, parseSpend, requireJsonContentType, withErrorHandling } from '@/src/api-shared';

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    const { id, spendUsdc } = await req.json();
    const { candidate, spec } = getCached(String(id));
    const q = await quote(candidate, parseSpend(spendUsdc));
    const gap = coverageGapDays(candidate, spec);
    return jsonResponse(200, {
      quote: {
        strike: q.strike, expiryIso: q.expiry.toISOString(),
        requestedUsdc: q.requestedUsdc, spendUsdc: q.spendUsdc, capped: q.capped,
        premiumUsdc: q.premiumUsdc, pricePerContract: q.pricePerContract, yourSide: q.yourSide,
        contracts: q.contracts,
      },
      judgment: judgeQuote(q, gap),
      payoff: payoffCurve(q, [q.strike * 0.8, q.strike * 1.2], 40),
    });
  });
}
