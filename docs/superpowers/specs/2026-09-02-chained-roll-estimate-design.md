# Payung — Chained-Roll Estimate ("Or chain shorter puts")

**Date:** 2026-09-02
**Status:** Approved for planning
**Scope:** Main product page only (not the `/watcher` page, which already has its own live rolling UI)

---

## 1. Problem statement

`filterCandidates`/`rankCandidates` ([src/core.ts:163-276](/home/yang/Project/MUBA/src/core.ts#L163)) only ever surface strikes that already exist on the live Thetanuts book. Live-book inspection (see debug run, 2026-09-02) shows this book's liquidity is bimodal: dense, tightly-spaced strikes near-dated (0–3 days), sparse and widely-spaced strikes at the tenors users actually ask for (8–35 days). For a real query — ETH, floor $2,225/unit, 14-day horizon — the *only* two strikes that cover the horizon are $2,150 and $2,300, a $150 gap straddling the user's ask, while $2,200/$2,220/$2,240/$2,250/$2,260/$2,280 all exist live but expire in ≤2.8 days.

The user's question: since the book already supports rolling a position forward as it nears expiry (`src/watcher.ts`, `src/policy.ts`, `app/api/watcher/roll`), is chaining several near-dated puts together a viable way to get a floor close to their actual target, ahead of ever buying anything? Today the main page has no way to show this — the only options presented are the (possibly far-off-target) full-horizon strikes.

This spec adds a **planning-only estimate**, shown alongside the real offers, so a user can compare "the nearest full-horizon strike the book actually has" against "what chaining near-dated strikes toward my exact target would theoretically cost." It does not change execution: buying the first leg uses the existing buy flow, and the already-shipped `/watcher` roll UI is what actually manages each subsequent roll once a position exists.

---

## 2. Invariants (carried over, unchanged)

1. **The model never originates a number the user sees** — this feature adds none; every number is either a live quote or a closed-form calculation over live inputs (spot, live IV).
2. **If nothing on the book fits, the system says so** — if no near-dated candidate exists to anchor an estimate, `estimateRoll` returns `null` and the UI shows nothing rather than a fabricated number.
3. Nothing in this feature touches `execute()`, `simulate()`, or fund movement. It is read-only math on top of `getBook()`'s existing output.

---

## 3. What "estimated price for the rolling" means, precisely

There are two numbers, never conflated in the UI:

- **The anchor leg's premium — real, exact.** The nearest-to-target strike among candidates that *don't* cover the full horizon (i.e., the `short` partition `rankCandidates` already computes internally) is a live, fillable order. Its premium comes straight from the book, same as any other candidate — no estimation involved.
- **The estimated total to cover the full horizon — theoretical.** This is a Black-Scholes price for a put struck at the user's *exact* target, at the user's *exact* horizon, computed from the market's currently-quoted risk (see §4). No such order exists on the book. It is explicitly labeled "ESTIMATED — theoretical, not a live quote" and never styled to look like a real offer.

The feature does not attempt to simulate each individual future roll (leg 2's strike, leg 3's strike, ...) because nothing constrains what a market maker will actually post at that future moment — that is a liquidity question, not a pricing question, and no model can answer it honestly. Instead it answers a narrower, defensible question: *"if a market maker priced my exact target strike/tenor consistently with what they're already charging nearby on the book right now, what would it cost?"*

---

## 4. The Black-Scholes / IV model, in detail

### 4.1 Why Black-Scholes instead of extrapolating the anchor leg's price linearly

An option's time value does not scale linearly with days-to-expiry — it scales roughly with `√T` (time enters the Black-Scholes formula as √T, and theta decay accelerates as expiry nears). Taking the anchor leg's `$/day` rate (a 2.8-day rate) and multiplying it straight across 14 days systematically overstates the true cost, because short-dated options carry a disproportionately high `$/day` rate. Black-Scholes avoids this by pricing the target tenor directly rather than rescaling a different tenor's rate.

### 4.2 Where "IV" comes in

Black-Scholes needs 5 inputs: spot, strike, time-to-expiry, risk-free rate, and volatility. The first four are known facts. Volatility is the only free parameter — and it is not invented here: every live order already carries the market's own **implied volatility**, in `candidate.greeks.iv` ([src/core.ts:81](/home/yang/Project/MUBA/src/core.ts#L81), populated from `o.rawApiData?.greeks` in `decodeOrder`, already wired to the UI in `src/api-shared.ts:92`). IV is the volatility figure that, fed back into Black-Scholes alongside that order's own strike/expiry, reproduces the market maker's actual quoted premium — i.e., it's already a reverse-engineered read of "how much movement this market maker is currently pricing in," not a forecast this app produces.

### 4.3 The calculation

```
anchorLeg = nearest-strike-to-target candidate among the SHORT (non-covering) partition,
            restricted to candidates with a numeric greeks.iv

if anchorLeg is null (no near-dated candidate, or none report IV):
    return null   // never fabricate

iv       = anchorLeg.greeks.iv                       // e.g. 0.55 (55% annualized)
spot     = live Chainlink spot for spec.asset          // fetchSpot(), same feed findCandidates() matches on
strike   = spec.floorTotalUsd / spec.quantity           // impliedStrike(spec) — the user's exact target
tYears   = spec.horizonDays / 365                        // the user's full stated window
r        = risk-free rate constant (see §4.4)

estimatedTotalPremiumUsd = bsPut(spot, strike, tYears, r, iv) * quantity
```

`bsPut` is the standard European put formula:

```
d1 = (ln(spot/strike) + (r + iv^2/2) * tYears) / (iv * sqrt(tYears))
d2 = d1 - iv * sqrt(tYears)
put = strike * e^(-r*tYears) * N(-d2) - spot * N(-d1)
```

where `N` is the standard normal CDF. This lives in a new, pure, dependency-free module (`src/blackscholes.ts`) so it is unit-testable against known reference values independent of any live data.

### 4.4 Risk-free rate

Use a fixed constant (e.g. `0.045`) rather than a fetched value — at these tenors (single-digit-to-mid-double-digit days) the discounting term `e^(-r*T)` moves the price by fractions of a cent, far inside the model's other uncertainty. Not worth a network call or a config surface.

### 4.5 What this number does and does not claim

**Does:** show what the user's exact strike/tenor would theoretically cost if priced consistently with the market's own currently-quoted risk appetite nearby on the book.

**Does not:** predict that a market maker will actually post that strike; predict future IV (today's IV is used as-is, not forecast forward); guarantee any specific number of rolls will land at favorable strikes. The UI must state the estimate is theoretical and that actual rolls depend on the book at the time each one executes — same "no invention" posture as the rest of the product (Invariant 2, §2).

---

## 5. Data flow

```
app/api/candidates/route.ts
  → findCandidates(spec)                         (existing)
  → fetchSpot(feed, provider) [+ spotCache]       (existing, reused from app/api/history/route.ts pattern)
  → estimateRoll(eligible, spec, spot.price)      (new, src/core.ts)
       → bsPut(...)                               (new, src/blackscholes.ts)
  → response.rollEstimate = { ... } | null
```

### 5.1 New types

```ts
// src/core.ts
export type RollEstimate = {
  anchorLeg: Candidate;
  anchorPremiumUsd: number;      // real, live — anchorLeg.pricePerContract * quantity
  estimatedLegs: number;         // Math.ceil(spec.horizonDays / anchorLeg.daysToExpiry)
  estimatedTotalPremiumUsd: number; // theoretical, from bsPut
  ivUsed: number;
  spotUsed: number;
};

export function estimateRoll(
  eligible: Candidate[],
  spec: ProtectionSpec,
  spotPrice: number
): RollEstimate | null;
```

### 5.2 API response addition

```ts
// app/api/candidates/route.ts — additive field, existing `candidates`/`coverage` unchanged
{
  candidates: [...],
  coverage: { ... },
  rollEstimate: RollEstimate | null,
}
```

---

## 6. UI

New card on the main page, below "Live offers that actually match," rendered only when `rollEstimate !== null`:

- Header: *"Or chain shorter puts"*
- Anchor leg shown exactly like a normal offer card (real strike, real expiry, real premium — it IS a live, fillable order) with a "Buy this first leg" CTA that goes through the existing buy flow.
- Estimated total shown in a visually distinct, non-green treatment (never the "FULL COVER"/green badge styling reserved for real full-horizon matches), labeled **"~$X estimated to reach your full [N]-day floor — theoretical, not a live quote. Actual cost depends on the book each time you roll."**
- `estimatedLegs` shown as supporting context: *"≈N rolls to your deadline."*
- After the first leg is bought, subsequent rolls are handled by the existing `/watcher` page — this card links there, it does not duplicate that UI.

---

## 7. Testing

- `tests/blackscholes.test.ts` — `bsPut` against known reference values (pure math, no fixtures needed).
- `tests/roll-estimate.test.ts` — `estimateRoll` using the existing `tests/fixtures.ts` pattern (e.g. `greeks: { iv: 0.55 }`): covers the null case (no near-dated IV-bearing candidate), the happy path, and the `estimatedLegs` rounding.
- No changes needed to `filterCandidates`/`rankCandidates` — this feature reads their output, it does not alter ranking.

---

## 8. Explicitly out of scope

- Predicting future IV (forecasting, ML, GARCH, etc.) — rejected during brainstorming: this book is too young/thin to train anything trustworthy, and it would violate the product's own "never invent a number" design rule. Today's live IV is used as-is.
- Simulating per-leg future strikes/premiums individually — not answerable without inventing liquidity that doesn't exist yet (§3).
- Any change to `/watcher`'s existing roll execution — reused as-is.
