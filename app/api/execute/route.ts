import { quote, assertFillable, collateralDecimals, writeClient, execute } from '@/src/core';
import { ensureDollarCollateral } from '@/src/aave';
import {
  getCached, jsonResponse, parseSpend, requireJsonContentType,
  serverSigningAllowed, SERVER_SIGNING_REFUSAL, withErrorHandling,
} from '@/src/api-shared';

export async function POST(req: Request) {
  const badContentType = requireJsonContentType(req);
  if (badContentType) return badContentType;

  return withErrorHandling(async () => {
    // MUST come before every other check: this route moves real money from the
    // server's own wallet with no authentication. See serverSigningAllowed.
    if (!serverSigningAllowed()) return jsonResponse(403, { error: SERVER_SIGNING_REFUSAL });
    const { id, spendUsdc, confirm } = await req.json();
    if (confirm !== true) return jsonResponse(400, { error: 'Set confirm:true — this spends real USDC on Base mainnet.' });
    const { candidate } = getCached(String(id));
    const client = writeClient();
    // Check fillability BEFORE spending anything — including the Aave deposit
    // below, which is itself a real transaction. Checking only inside
    // execute() (after the deposit) means a stale/unfillable order costs a
    // real deposit tx before the fill is ever refused.
    assertFillable(candidate, Math.floor(Date.now() / 1000));
    // Same sequencing as the CLI's shared quote/simulate/execute case: quote
    // to get the maker-capped spend, ensure collateral for THAT amount, then
    // execute with it — never the raw requested number.
    const q = await quote(candidate, parseSpend(spendUsdc), client);
    const dec = await collateralDecimals(client, candidate.collateralToken);
    await ensureDollarCollateral(client, candidate.collateralToken, BigInt(Math.round(q.spendUsdc * 10 ** dec)));
    const result = await execute(candidate, q.spendUsdc, client);
    return jsonResponse(200, { hash: result.hash, explorer: result.explorer, paidUsd: result.paidUsd });
  });
}
