<!-- docs/settlement-findings.md -->
# Settlement behaviour — measured, 2026-08-31 (corrected 2026-08-31, fix round 1)

**Question:** after expiry, does a cash-settled OptionBook put pay the buyer
automatically, or must someone call something?

**Correction note:** this document's first version drew its central mechanism
claim ("permissionless `Payout`, buyer has a reliable self-serve fallback")
from a 2,690-position sample that turned out to be ~94% pre-dated by a
vendor-documented contract upgrade (r12, see below) that, per the SDK's own
code comment, removed exactly that entrypoint. Task review caught this. This
version separates the parts of the original finding that survive that
scrutiny from the part that needed real re-investigation — see Conclusion.

## Method
`client.positions.list(...)` sketched in the task brief does not exist on the
installed SDK (`@thetanuts-finance/thetanuts-client`). The codebase's existing
call, `client.api.getUserPositionsFromIndexer(address)` (used by
`app/api/positions/route.ts`), is scoped to one wallet — too narrow for a
protocol-wide sample. Instead `scripts/settlement-probe.ts` uses
`client.api.getBookState()`, a real, documented SDK method whose doc comment
states it "Returns all OptionBook positions, user position mappings, and
metadata" — the actual broad listing the brief wanted. It returns raw
(un-normalized) indexer rows; the script reads `optionStatus`, `side`,
`settlement.explicitDecision`, `implementationName` ('PUT' = cash-settled,
'PHYSICAL_PUT' = physical-settled), `closeTimestamp`, and the flat
`expiryTimestamp` field directly off those rows, then real settling
transactions were inspected on BaseScan to identify who actually calls the
settlement function (BaseScan labels it `Payout`, selector `0x63bd1d4a`).

**Fix round 1 addition:** the installed SDK's `OptionModule.payout()`
(`dist/index.js:7676-7703`) carries an `@deprecated` note claiming the r12
`BaseOption` deployment (2026-05-05, block 45601440, per
`CHAIN_CONFIGS_BY_ID[8453].deploymentBlock`) removed the user-callable
`payout()` entrypoint — the method now throws `INVALID_PARAMS` instead of
sending a transaction. Two things were checked in response:
1. Whether `OptionBookModule` — the *only* module `src/core.ts` actually
   calls (`previewFillOrder`, `fillOrder`, `cancelOrder`,
   `callStaticFillOrder`, fee methods) — has any settlement/payout/exercise
   method at all. Confirmed by listing every method in its class body
   (`dist/index.js:1513-2538`): it does not. The closest are `claimFees` /
   `claimAllFees`, which are protocol-fee claims, unrelated to option
   settlement. So Payung's own code was never going to call a settlement
   trigger through the SDK either way — consistent with the deprecation
   note's claim that settlement doesn't need a user-callable entrypoint.
2. Whether cash-settled `PUT` contracts created *after* the r12 cutover
   still have a working payout path in practice, split by `entryBlock`
   (contract creation — the correct dimension, not `closeTimestamp`, since a
   pre-r12 contract can still close after the cutover date).

## Numbers
(All from a live query against the Thetanuts indexer on Base mainnet,
2026-08-31. Full JSON in the run log below.)

- Protocol-wide sample: 15,498 total book positions; 15,455 settled buyer
  positions across all option implementations (puts, calls, spreads, etc.)
- **Cash-settled PUT only** (the instrument in question), settled buyer
  positions sampled: **2,690**
- `explicitDecision: false` (automatic): **2,690** (100%)
- `explicitDecision: true` (explicit): **0** (0%)
- Median delay expiry -> settlement (cash PUT): **3,755 seconds (~62.6 min)**;
  range 5s to 1,149,413s (~13.3 days, one outlier)
- Positions currently `expired-awaiting-settlement`: **0** (protocol-wide,
  across all 15,498 sampled positions — nothing is stuck)
- Settling sender(s): verified via BaseScan on **5** real cash-settled PUT
  transactions where the buyer was actually paid
  (`optionStatus: settled-itm`, `settlement.payoutBuyer > 0`):
  - `0x52231eabe2...` — sender = **buyer** (`0x710E1A09...`)
  - `0x7cbdc2a59a...` — sender = **buyer** (`0x4fC5921E...`)
  - `0xe65b2efb00...` — sender = **seller** (`0xf1711BA7...`)
  - `0x6cf28c823a...` — sender = **seller** (`0xf1711BA7...`)
  - `0x98f1a249e8...` — sender = **seller** (`0xf1711BA7...`)

  So 3/5 sampled settlements were triggered by the **seller**, 2/5 by the
  **buyer**. In every case BaseScan shows a single `Payout` call that moves
  **both** legs atomically — the buyer's payout and the seller's collateral
  return land in the same transaction regardless of who submitted it.
  Every observed caller, across all transactions checked in this document
  (5 here, 9 more in the r12-specific check below), was **either the
  position's buyer or its seller — never an unrelated third party**. Whether
  the contract's access control would actually accept a call from a genuine
  outsider was not checked against source/ABI, so "either counterparty can
  call it" is what's evidenced; "anyone/permissionless" would be an
  extrapolation beyond that. Across the full 2,690-position cash-PUT sample,
  only **2 distinct seller addresses** appear at all:
  `0xf1711BA7E74435032AA103Ef20a4cBeCE40B6df5` (2,534 positions, ~94%) and
  `0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E` (156 positions, ~6%). Neither
  address carries a BaseScan label identifying it as Thetanuts-operated —
  settling ~94% (and, per the r12 split below, effectively 100% of the
  post-r12 subset) of all sampled positions makes "likely a market-maker
  bot" a reasonable inference, not a confirmed fact. (`0xEcda1D00...` is at
  least independently corroborated as a counterparty in `HANDOFF.md`'s own
  burner-wallet fill.)

  Aside, for context: `explicitDecision: true` occurs almost exclusively on
  `PHYSICAL_PUT` settlements (132/187 sampled, ~71%), never on cash-settled
  `PUT` settlements (0/2,690). This is consistent with physical settlement
  requiring an exercise choice, while cash settlement resolves mechanically
  off the oracle price.

### r12 split (fix round 1)
Splitting the 2,690 cash-settled-PUT buyer-settled sample by `entryBlock`
(contract creation block) against the r12 cutover (block 45601440):

- **Pre-r12** (`entryBlock < 45601440`): **2,534** positions (94.2%)
- **Post-r12** (`entryBlock >= 45601440`): **156** positions (5.8%)
- Of those 156, **43** are `settled-itm` with `settlement.payoutBuyer > 0` —
  the case that actually tests whether the buyer gets paid.
- All **156** post-r12 positions share a single seller,
  `0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E` — a full changeover from the
  pre-r12 sample's dominant seller (`0xf1711BA7...`), consistent with (but
  not proof of) a market-maker/operational rotation around the same r12
  cutover.
- For comparison, splitting by `closeTimestamp` instead (a weaker proxy,
  since a pre-r12 contract can still close after the cutover date) gives
  164 "closed after r12" — 8 of those 164 were actually **entered** before
  the cutover block, i.e. long-dated pre-r12 contracts that just closed
  late. `entryBlock` is the correct dimension and is what's used above.

**On-chain verification of the post-r12 subset:** 9 rows were sampled
systematically from the 43 post-r12 buyer-paid positions — sorted by
`entryBlock` and taken at roughly every 5th position (indices 0, 5, 10, 15,
20, 25, 30, 35, 40 of 43), giving even coverage across the full post-r12
window rather than clustering near the cutover. This is a **non-random,
n=9** sample (plus one transaction the reviewer had already checked
independently, for n=10 total). Every one was opened directly on BaseScan:

| closeTxHash (short) | entryBlock | Date | Sender | Role |
|---|---|---|---|---|
| `0x07DB2078...` (reviewer's check) | 46872794 | 2026-06-04 | not recorded by reviewer | succeeded |
| `0x7e567df6...` | 45677541 | 2026-05-07 | `0xEcda1D00...` | seller |
| `0xc5f83cb2...` | 45850332 | 2026-05-11 | `0xEcda1D00...` | seller |
| `0xdec6145e...` | 46626328 | 2026-05-29 | `0xFe22C9d0...` | buyer |
| `0xe825c84f...` | 46885376 | 2026-06-04 | `0x28f28E8e...` | buyer |
| `0x9042f776...` | 46928646 | 2026-06-05 | `0x710E1A09...` | buyer |
| `0xa898e29e...` | 47232751 | 2026-06-12 | `0xEcda1D00...` | seller |
| `0x1f8d4f54...` | 48744737 | 2026-07-17 | `0xEcda1D00...` | seller |
| `0x7e6ffc53...` | 50429547 | 2026-08-25 (6 days ago) | `0xEcda1D00...` | seller |
| `0x8eb4e1fa...` | 50601366 | 2026-08-29 (2 days ago) | `0x49cbf776...` | buyer |

**10/10 succeeded.** 5 seller-triggered, 4 buyer-triggered, 1 unrecorded-role
(reviewer's check, also succeeded). None reverted; none showed the
`INVALID_PARAMS` behavior the SDK's deprecation note describes. The most
recent is 2 days before this document's date.

**Bytecode-level check, not just transaction outcomes:** the option contract
behind the most recent transaction (`0xd28b8357...`, entryBlock 50429547)
is an EIP-1167 minimal proxy; decoding its bytecode
(`...737355eb92dfb0503db558a70c10843618932ab290...`) shows it delegates to
`0x7355EB92dfb0503DB558a70c10843618932ab290` — which is *exactly* the r12
`PUT` implementation address in the installed SDK's own chain config
(`CHAIN_CONFIGS_BY_ID[8453].implementations.PUT`), and the proxy's creator
is `0x1bDff855d6811728acaDC00989e79143a2bdfDed`, the SDK's own r12
`optionBook` address. So this is unambiguously a genuine, current, r12 book
PUT — not a stale or misconfigured contract. Fetching that implementation
address's raw bytecode directly from BaseScan shows a Solidity function
dispatcher entry for selector `0x63bd1d4a` (`8063` + `63bd1d4a` + `14`) —
the exact selector BaseScan decodes as `Payout` in every transaction above.
The function is present in the deployed bytecode, contradicting the SDK's
ABI-level claim that it doesn't exist on r12.

## Conclusion

**Two claims were conflated in the first draft. They now get separated,
because they have different confidence levels and different implications
for Task 19.**

**Strong, keep at full confidence — build copy on this:** settlement
completes quickly and fully across the whole sample, regardless of era.
Median 62.6 minutes from expiry to settlement (cash-settled PUT); 0 of
15,455 sampled settled positions (protocol-wide, spanning both pre- and
post-r12) are stuck in `expired-awaiting-settlement`. This claim is about
*outcome and timing*, not about *who or what triggers it*, so it is not
undermined by the r12 concern below — the r12 split above shows the same
"nothing stuck, fast median" pattern holds inside the post-r12 subset too
(median 60.25 minutes, min 11s / max 18,551s across the 156 post-r12
positions).

**Uncertain — must be stated as uncertain, not asserted:** whether a
Payung buyer specifically has a *durable, guaranteed* self-serve manual
fallback via a callable payout-equivalent function on *current* (post-r12)
book-PUT contracts. Three sources of evidence point in different
directions and none is fully authoritative:
- The vendor's own SDK says, in writing, that no such user-callable
  entrypoint exists on r12 (`OptionModule.payout()` throws `INVALID_PARAMS`
  by design, citing audit fix TNU-AUDIT-0046).
- `OptionBookModule` — the only module Payung's own code calls — has no
  settlement method at all, so Payung cannot currently trigger this through
  the SDK's supported API regardless of what the contract allows.
- Yet 10/10 directly-verified post-r12 on-chain transactions (systematic,
  non-random sample of 9 plus the reviewer's 1, spanning 2026-05-07 through
  2026-08-29 — 2 days before this document's date) show the payout call
  succeeding, callable by either buyer or seller, and the implementation
  contract's own deployed bytecode still contains the function selector in
  question. This is on-chain fact, not a code comment, and it directly
  contradicts the SDK's blanket claim for cash-settled PUT contracts
  specifically.

  The honest conclusion is **unresolved without vendor confirmation.** The
  contract-level evidence is strong and recent, but a documented vendor
  claim actively contradicting it — for reasons this investigation could
  not determine (stale documentation? a difference between what the audit
  fix intended and what got deployed? something specific to how `PUT`
  differs from whatever `BaseOption.json` variant the note describes?) — is
  not something to paper over with confident copy. Separately, even where
  the on-chain function does work, Payung's own code has no supported way to
  call it today (the SDK actively blocks the documented path), so a "claim
  payout" UI button would require a raw contract call bypassing the SDK's
  guard, which is a real engineering decision, not a given.

**Recommendation for Task 19:** build settlement copy on the strong claim —
"settlement is fast and automatic, typically resolving within about an hour
of expiry" — backed by the 0-stuck / fast-median numbers above, which hold
in both the pre- and post-r12 eras. Do **not** promise a specific manual
"claim your payout" mechanism or name the counterparty who will trigger it,
until the vendor or mentor confirms current behavior. If a user asks what
happens if nothing arrives, point them to BaseScan / Thetanuts support
rather than asserting a specific on-chain action Payung has not confirmed
it can safely instruct them to take.

## Confirmation
Not yet asked — no mentor channel was available in this session. Given the
Critical review finding above, this should be a priority follow-up before
Task 19 ships any copy that implies a specific settlement mechanism (keeper,
market-maker, or buyer self-serve), even though the timing/outcome claim is
independently well-evidenced enough to build on now.

## Raw run
```
$ npx tsx scripts/settlement-probe.ts
```
See `scripts/settlement-probe.ts` output (full JSON, protocol-wide +
cash-PUT-only + buyer-actually-paid + settling-counterparty-concentration
breakdowns) — reproduced in the task-1 implementation report.
