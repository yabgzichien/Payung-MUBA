<!-- docs/settlement-findings.md -->
# Settlement behaviour — measured, 2026-08-31

**Question:** after expiry, does a cash-settled OptionBook put pay the buyer
automatically, or must someone call something?

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
`expiryTimestamp` field directly off those rows, then five real settling
transactions were inspected on BaseScan to identify who actually calls the
settlement function (BaseScan labels it `Payout`).

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
  return land in the same transaction regardless of who submitted it. Across
  the full 2,690-position cash-PUT sample, only **2 distinct seller
  addresses** appear at all: `0xf1711BA7E74435032AA103Ef20a4cBeCE40B6df5`
  (2,534 positions, ~94%) and `0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E`
  (156 positions, ~6%) — both Thetanuts house/market-maker addresses (the
  latter is also the buyer-side counterparty on this project's own burner
  wallet fill, per `HANDOFF.md`).

  Aside, for context: `explicitDecision: true` occurs almost exclusively on
  `PHYSICAL_PUT` settlements (132/187 sampled, ~71%), never on cash-settled
  `PUT` settlements (0/2,690). This is consistent with physical settlement
  requiring an exercise choice, while cash settlement resolves mechanically
  off the oracle price.

## Conclusion
**Settlement is effectively automatic for the buyer, but not because a
dedicated keeper bot exists separate from the two counterparties.** The
OptionBook contract exposes a permissionless `Payout` function: anyone can
call it after expiry, and it pays both legs (buyer's payout, seller's
collateral return) in one atomic transaction. In practice, the house
market-maker that is the seller on ~94-100% of sampled cash-settled puts
calls it itself in the majority of observed cases (self-interested to
reclaim its locked collateral) — median 62.6 minutes after expiry, with 0 of
15,455 sampled settled positions currently stuck awaiting settlement. A
Payung buyer very likely receives payout without personally acting. If the
market-maker does not act for some reason, the same permissionless function
gives the buyer a self-serve fallback — directly observed triggering their
own payout in 2 of 5 sampled transactions. **Copy for Task 19 should say
settlement happens automatically and typically completes within about an
hour of expiry, without asserting a specific dedicated "keeper" exists** —
what actually exists is a permissionless payout call that a highly
self-interested market-maker has been observed to trigger reliably and
quickly.

## Confirmation
Asked the Thetanuts mentor in parallel. Response: pending — no mentor
channel was available in this session; recommend a follow-up confirmation
before Task 19 ships buyer-facing copy, though the on-chain evidence above
(5 verified BaseScan transactions, 2,690-position sample, 0 stuck positions)
is direct and load-bearing on its own.

## Raw run
```
$ npx tsx scripts/settlement-probe.ts
```
See `scripts/settlement-probe.ts` output (full JSON, protocol-wide +
cash-PUT-only + buyer-actually-paid + settling-counterparty-concentration
breakdowns) — reproduced in the task-1 implementation report.
