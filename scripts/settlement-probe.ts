// THROWAWAY. Answers one question: who settles an expired book put, and when?
//
// ADAPTATION NOTE: the brief sketched `client.positions.list({ limit: 500 })`.
// That method does not exist on the installed SDK
// (@thetanuts-finance/thetanuts-client). The SDK's only user-facing "list
// positions" call, `client.api.getUserPositionsFromIndexer(address)` (the one
// app/api/positions/route.ts already uses), is scoped to a single wallet —
// too narrow for a protocol-wide sample. Instead this uses
// `client.api.getBookState()`, a real, documented SDK method whose own doc
// comment says it "Returns all OptionBook positions, user position mappings,
// and metadata" — i.e. the actual broad multi-user listing the brief wanted.
// It returns an untyped blob (`Record<string, unknown>`) rather than the
// normalized `Position[]` shape, so field access below is against the raw
// indexer row shape (confirmed live): flat `expiryTimestamp` (not a nested
// `option.expiry`), `closeTimestamp`, `closeTxHash` (no `0x` prefix, same
// quirk documented in app/api/positions/route.ts's normalizeHash), `side`,
// `optionStatus`, `settlement.explicitDecision`, and `implementationName`
// ('PUT' = cash-settled put, 'PHYSICAL_PUT' = physical-settled put).
//
// FIX ROUND 1 ADDITION: review flagged that `OptionModule.payout()` in this
// same installed SDK (dist/index.js:7676-7703) is `@deprecated` — its doc
// comment claims the r12 BaseOption deployment (2026-05-05, block 45601440,
// per `CHAIN_CONFIGS_BY_ID[8453].deploymentBlock`) removed the user-callable
// `payout()` entrypoint entirely, and the method now throws `INVALID_PARAMS`
// instead of sending a transaction. Most of the sample below pre-dates that
// cutover, so the split below isolates the post-r12 subset specifically —
// see docs/settlement-findings.md for the on-chain verification of whether
// that deprecation note actually holds for cash-settled PUT contracts.
import 'dotenv/config';
import { readClient } from '../src/core.js';

// Base_r12 deployment block, per the installed SDK's own chain config
// (CHAIN_CONFIGS_BY_ID[8453].deploymentBlock, dist/index.js:169). The correct
// dimension for "is this option contract pre- or post-r12" is when the
// contract itself was created (entryBlock — book options are deployed as a
// fresh minimal-proxy clone at fill/entry time), NOT when it later closed.
// A long-dated pre-r12 position can close well after this date while still
// running on the pre-r12 implementation.
const R12_DEPLOYMENT_BLOCK = 45601440;

function summarize(label: string, subset: any[]) {
  const settled = subset.filter(
    (p) => p.optionStatus === 'settled-itm' || p.optionStatus === 'settled-otm'
  );
  const buyers = settled.filter((p) => p.side === 'buyer');

  const explicit = buyers.filter((p) => p.settlement?.explicitDecision === true).length;
  const automatic = buyers.filter((p) => p.settlement?.explicitDecision === false).length;

  const delays = buyers
    .map((p) => Number(p.closeTimestamp) - Number(p.expiryTimestamp))
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  const median = delays.length ? delays[Math.floor(delays.length / 2)] : null;

  const awaitingSettlement = subset.filter((p) => p.optionStatus === 'expired-awaiting-settlement').length;

  return {
    label,
    totalRows: subset.length,
    settledBuyerPositions: buyers.length,
    explicitDecisionTrue: explicit,
    explicitDecisionFalse: automatic,
    medianSettlementDelaySec: median,
    minDelaySec: delays.length ? delays[0] : null,
    maxDelaySec: delays.length ? delays[delays.length - 1] : null,
    awaitingSettlement,
    // BaseScan expects a 0x-prefixed hash; the indexer's raw hash has none.
    sampleCloseTxHashes: buyers.slice(0, 5).map((p) => `0x${p.closeTxHash}`),
    sampleBuyerSeller: buyers.slice(0, 5).map((p) => ({ buyer: p.buyer, seller: p.seller })),
  };
}

async function main() {
  const client = readClient();
  const state: any = await client.api.getBookState();
  const rows: any[] = Object.values(state?.positions ?? {});

  const cashPuts = rows.filter((p) => p.implementationName === 'PUT');

  // The buyer-gets-paid case specifically (settled-itm, payout > 0) — the
  // one that actually exercises the "does the buyer receive money" path,
  // as opposed to settled-otm where the buyer's payout is legitimately zero.
  const cashPutsPaidToBuyer = cashPuts.filter(
    (p) =>
      p.side === 'buyer' &&
      p.optionStatus === 'settled-itm' &&
      p.settlement?.payoutBuyer != null &&
      BigInt(p.settlement.payoutBuyer) > 0n
  );

  // Concentration of settling counterparties: are a small number of
  // addresses doing all the settling (house market-maker acting keeper-like),
  // or is it genuinely diffuse?
  const sellerCounts = new Map<string, number>();
  for (const p of cashPuts) {
    if (p.side !== 'buyer') continue;
    if (p.optionStatus !== 'settled-itm' && p.optionStatus !== 'settled-otm') continue;
    const s = String(p.seller).toLowerCase();
    sellerCounts.set(s, (sellerCounts.get(s) ?? 0) + 1);
  }
  const topSellers = [...sellerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // FIX ROUND 1: pre/post r12 split of the cash-settled-PUT buyer-settled
  // sample, by entryBlock (contract creation), not closeTimestamp.
  const cashPutBuyerSettled = cashPuts.filter(
    (p) => p.side === 'buyer' && (p.optionStatus === 'settled-itm' || p.optionStatus === 'settled-otm')
  );
  const preR12 = cashPutBuyerSettled.filter((p) => Number(p.entryBlock) < R12_DEPLOYMENT_BLOCK);
  const postR12 = cashPutBuyerSettled.filter((p) => Number(p.entryBlock) >= R12_DEPLOYMENT_BLOCK);
  const postR12PaidToBuyer = postR12.filter(
    (p) => p.optionStatus === 'settled-itm' && p.settlement?.payoutBuyer != null && BigInt(p.settlement.payoutBuyer) > 0n
  );
  const postR12SellerCounts = new Map<string, number>();
  for (const p of postR12) {
    const s = String(p.seller).toLowerCase();
    postR12SellerCounts.set(s, (postR12SellerCounts.get(s) ?? 0) + 1);
  }
  const postR12Delays = postR12
    .map((p) => Number(p.closeTimestamp) - Number(p.expiryTimestamp))
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  const postR12Median = postR12Delays.length ? postR12Delays[Math.floor(postR12Delays.length / 2)] : null;

  console.log(JSON.stringify({
    protocolWideAllImplementations: summarize('ALL implementations', rows),
    cashSettledPutOnly: summarize('PUT (cash-settled)', cashPuts),
    cashSettledPutBuyerActuallyPaid: {
      count: cashPutsPaidToBuyer.length,
      sample: cashPutsPaidToBuyer.slice(0, 5).map((p) => ({
        optionAddress: p.optionAddress,
        buyer: p.buyer,
        seller: p.seller,
        closeTxHash: `0x${p.closeTxHash}`,
        delaySec: Number(p.closeTimestamp) - Number(p.expiryTimestamp),
        payoutBuyer: p.settlement.payoutBuyer,
      })),
    },
    distinctSettlingCounterparties: {
      distinctSellerCount: sellerCounts.size,
      totalSettledBuyerPositions: cashPutBuyerSettled.length,
      topSellersByPositionCount: topSellers,
    },
    r12SplitOfCashSettledPutBuyerSample: {
      deploymentBlockUsedAsCutover: R12_DEPLOYMENT_BLOCK,
      totalCashPutBuyerSettled: cashPutBuyerSettled.length,
      preR12ByEntryBlock: preR12.length,
      postR12ByEntryBlock: postR12.length,
      postR12SettledItmPayoutBuyerGtZero: postR12PaidToBuyer.length,
      postR12DistinctSellers: [...postR12SellerCounts.entries()].sort((a, b) => b[1] - a[1]),
      postR12MedianSettlementDelaySec: postR12Median,
      postR12MinMaxDelaySec: postR12Delays.length ? [postR12Delays[0], postR12Delays[postR12Delays.length - 1]] : [null, null],
      // Full post-r12 buyer-paid list (small enough to print in full — this
      // is the exact set a manual BaseScan sample should be drawn from).
      postR12PaidToBuyerRows: postR12PaidToBuyer.map((p) => ({
        optionAddress: p.optionAddress,
        buyer: p.buyer,
        seller: p.seller,
        entryBlock: Number(p.entryBlock),
        closeTxHash: `0x${p.closeTxHash}`,
        payoutBuyer: p.settlement.payoutBuyer,
      })),
    },
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
