# Payung

*Payung* — Malay for "umbrella." You buy protection before it rains.

**One-liner:** Tell it what you're afraid of losing. It finds you a real, contractual floor on the actual Thetanuts marketplace, on Base mainnet, and executes it — no options jargon required.

Built for **MUBA Hacks 2026**, targeting both Thetanuts tracks:
- **Track 01 — SDK Product** ($1,000): a real working product on the Thetanuts SDK
- **Track 02 — AI × Options** ($1,000): an AI agent that executes a real on-chain options trade against live pricing

---

## Thetanuts tracks — full official descriptions

### Track 01 — SDK Product

> **Best product built on the Thetanuts SDK — 1,000 USDC**
> Build any working product on the Thetanuts SDK, a decentralized options protocol on Base.
>
> **Possibilities:** Structured products • vaults • consumer trading apps • options-powered lending • analytics • entirely new options use cases
>
> **The bar:** Deliver a real working product that uses on-chain options meaningfully.
>
> **Resources:** `@thetanuts-finance/thetanuts-client` · [docs.thetanuts.finance/sdk](https://docs.thetanuts.finance/sdk)

### Track 02 — AI × Options

> **AI × Options — 1,000 USDC**
> Build an AI agent that places a real on-chain options trade on Thetanuts' OptionBook or OptionFactory, live on Base mainnet.
>
> **Ideas:** Natural-language trading • AI strategy/risk copilot • autonomous hedging agent
>
> **The bar:** Execute at least one real trade against live pricing — not paper trading and not testnet.
>
> **Resources:** Thetanuts MCP server, `@thetanuts-finance/mcp` · [docs.thetanuts.finance/sdk](https://docs.thetanuts.finance/sdk)

### How Payung maps onto both bars

| Track | Bar to clear | How Payung clears it |
|---|---|---|
| 01 — SDK Product | "Real working product that uses on-chain options **meaningfully**" | Options-powered downside protection is a listed possibility, not a stretch — and "meaningfully" is satisfied because the option is the *correct instrument* for the stated constraint, not a bolted-on feature |
| 02 — AI × Options | "Execute at least one **real** trade against **live pricing** — not paper, not testnet" | Every quote comes from `previewFillOrder()` against the live Base mainnet orderbook; the agent only picks among real, currently-fillable orders and calls `fillOrder()` for real — confirmed working end-to-end in this session down to a $10 simulated fill |

---

## What it is (plain version)

If you hold crypto — say 1 ETH, worth about $2,450 today — its price can drop hard with zero warning, and normally there's nothing you can do except sell and hope you timed it right.

Payung lets you say, in plain language:

> *"I have 1 ETH. I need it to be worth at least $2,300 in two weeks."*

It then finds a real offer on the Thetanuts marketplace — a real person or market maker willing to guarantee that price — shows you exactly what it costs, and executes the trade for real, on Base mainnet. You get a transaction hash you can look up on BaseScan.

This is not a prediction tool. It never guesses where the price is going. It only picks the correct financial instrument (a **put option**) for a constraint you stated, and shows you the real cost pulled from a live orderbook.

## Who it's for

- **Crypto holders who need a hard deadline and a hard floor** — e.g., a student who needs their ETH to be worth enough to cover tuition on a specific date, and can't afford to just "wait and see."
- **Anyone who has been burned by a stop-loss** — traders who've had a stop-loss fill far below the trigger price during a fast crash, or who got stopped out right before the market recovered.
- **People who understand they're exposed but don't want to learn options jargon** (strike, premium, IV, greeks) just to protect themselves.

It is explicitly *not* for people trying to predict or bet on price direction. That's a different product, and a much weaker hackathon pitch (see "The Pitch" below).

---

## How it actually works

1. **You state a constraint in plain language**: asset, floor price, time horizon.
2. **The system queries the live Thetanuts orderbook** on Base (via `fetchOrders()`), and filters to orders that are:
   - **Puts** (the correct instrument for "protect a floor under a long position")
   - **Buyable** — critically, only orders where the *market maker* is the buyer, meaning *you* are able to buy (roughly 20% of the live book; the rest would make you the seller, which is the opposite of protection)
   - Reasonably close to your requested strike and time horizon
3. **It prices the match** using the SDK's own `previewFillOrder()` — every number shown (premium, collateral, contracts) comes from the protocol's real collateral math, not an estimate.
4. **It simulates the real transaction for free** using `callStaticFillOrder()` — this runs the actual fill against current chain state and tells you if it would succeed, without spending anything.
5. **Only when you confirm does it spend real money** — it approves the correct collateral token (not hardcoded USDC — the book also quotes `aBasUSDC`, `aBasWETH`, and `cbBTC`) and calls `fillOrder()`.
6. **You get a transaction hash.** `https://basescan.org/tx/...` — real, verifiable, on mainnet.

### The mechanic that surprises people: your real ETH is never touched

The put option is a **separate cash-settled side contract**, not an instruction to sell your actual coins. Your ETH sits in your wallet, untouched, the entire time.

At the deadline:
- **If ETH is below your floor** (say $1,900 vs. a $2,300 floor): the contract automatically pays you cash — $2,300 − $1,900 = $400 per contract. Your real ETH is worth $1,900, but the $400 payout makes up the difference. No selling happened.
- **If ETH is above your floor** (say $2,600): the contract pays nothing and expires. You lose the premium you paid. Your real ETH, untouched the whole time, is now worth $2,600 — and it's still yours.

There's no moment where you "choose" to sell. It settles automatically based on a price comparison, like a bet resolving — which is exactly why it doesn't suffer the slippage a stop-loss does.

---

## Why this beats a stop-loss (not just "sounds like insurance")

| | Stop-loss | This (a put option) |
|---|---|---|
| **Mechanism** | Places a real sell order when price is hit | Pays out based on a price comparison at a deadline |
| **In a fast crash** | Can fill far below your trigger price if the order book is thin (common in crypto) — this happens constantly | The floor is computed at the deadline, not executed into a live market — it cannot slip. But it protects a **date**, not the path: a mid-window dip that recovers by expiry pays nothing |
| **What's protected** | The path — continuously, but only best-effort | One date — exactly. Real constraints have dates: tuition due, loan due |
| **What it costs** | Free to place | A premium, paid upfront (roughly 5–10% of protected value near the money — see the pricing table) |
| **If price recovers right after** | You already sold — you're in cash, watching the recovery without you | You still hold your ETH the whole time — you participate in any recovery |
| **Your real coins** | Actually sold | Never touched |

The one-sentence version: *a stop-loss is a best-effort order that can miss its own price in a fast crash and takes you out of your position; a put option is a contractual floor that is computed exactly at your deadline — it costs a premium and protects a date rather than the path, and you keep your asset and its upside the whole time.*

---

## Real pricing, pulled live from Base mainnet

Confirmed against the live Thetanuts orderbook (ETH trading ~$2,450), same 8.7-day window:

| Floor (strike) | Distance below spot | Premium |
|---|---|---|
| $2,080 | 15% below | $3.04 |
| $2,150 | 12% below | $5.07 |
| $2,200 | 10% below | $7.97 |
| $2,250 | 8% below | $12.50 |
| $2,300 | 6% below | $19.94 |
| $2,350 | 4% below | $30.96 |

The pattern: the closer your floor is to today's price, the more it costs — roughly 10x from the far end to the near end — because a floor that's barely below the current price is likely to actually get used. This is driven by three real, visible inputs: distance from spot, time horizon, and current volatility (`iv`, ~0.5–0.6 in this window).

**Where it stops making sense:** if the premium is eating more than roughly 5–10% of the value you're protecting for a short window, you're generally better off not buying it — you're paying more for peace of mind than the peace of mind is worth. Reading that tradeoff across a dozen strikes is tedious for a human and exactly the kind of judgment an AI assistant can compress into one sentence, using only real numbers from the live book — nothing invented.

---

## Architecture — one core, two submissions

```
        ┌─────────────────────────────────────┐
        │  Thetanuts execution core (src/core.ts) │
        │  fetchOrders → previewFillOrder →   │
        │  callStaticFillOrder (free sim) →   │
        │  ensureAllowance → fillOrder        │
        └──────────┬───────────────┬──────────┘
                   │               │
      ┌────────────▼─────┐   ┌────▼──────────────────┐
      │ FACE A: Track 02 │   │ FACE B: Track 01      │
      │ NL trading agent │   │ "buy a floor" UX,     │
      │ intent → structure│  │ zero options jargon   │
      │ → payoff → EXECUTE│  │                        │
      └──────────────────┘   └───────────────────────┘
```

The LLM (via Gonka Router, OpenAI-compatible) is only ever used to translate a stated human constraint into a filter over the live book. **It never generates a price, a prediction, or a number.** Every figure on screen comes from `previewFillOrder()` or the live orderbook directly. This is the load-bearing architectural claim for the pitch — it's what tells an options-literate judge the team understands the primitive, and it's not something a "chatbot bolted onto a wallet" competitor can credibly claim.

---

## The pitch

**Positioning line, said out loud to judges:**

> "Every other AI × Options submission will be 'AI predicts the price, AI buys calls.' An LLM has zero edge on price direction — that's a coin flip with extra steps, and it's the single most likely submission in this track. Ours never predicts anything. It translates a stated constraint into the correct instrument, prices it against a live orderbook, and executes for real. The one number we put on screen is a BaseScan transaction hash."

**Why the field is thin:** most student teams can't define a put option, let alone reason about strike/expiry/collateral — so the "real trade on live pricing, not testnet" gate in Track 02's brief filters out almost everyone before judging even starts. Two tracks, $2,000 combined, likely 1–5 teams competing for each.

**The demo, in order:**
1. State the constraint in plain English.
2. Show the candidate floors and real premiums, pulled live.
3. Show the payoff curve (protected vs. unprotected).
4. Execute for real.
5. Put the BaseScan link on screen.

---

## Confirmed technical facts (validated against live Base mainnet)

- **Live orderbook**: 342–403 fillable orders observed across the session (updates constantly).
- **Only ~20% of the book is buyable** by a retail taker — the rest has the market maker as buyer, meaning the counterparty side is you selling, not buying protection. This must be filtered explicitly (`order.isBuyer === false`).
- **`getPriceDecimals()` returns a scale (1e8), not a decimal count** — dividing by it as a decimal count silently zeroes every price. Divide by the value directly.
- **Collateral is not always USDC.** The live book also quotes `aBasUSDC`, `aBasWETH`, and `cbBTC`. Approvals must target the order's actual `collateralToken`, not a hardcoded address.
- **Buyable-put collateral, re-verified during this hardening pass:** the live book quoted `aBasUSDC` (`0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB`) for buyable puts. `findCandidates()` accepts any dollar-denominated collateral (USDC or aBasUSDC) discovered from the live book by symbol — never a hardcoded address — and the execute path auto-deposits USDC into Aave when an order needs `aBasUSDC` (a genuine positive: idle collateral earns Aave yield while it sits).
- **`callStaticFillOrder()` simulates the real transaction for free** — build and test the entire flow without spending anything; only the final, on-camera trade should be a real `fillOrder()` call.
- Minimum viable real trade: **~$10 USDC**, confirmed via `previewFillOrder()` against a live order.
- **NL intent parsing, live against Gonka Router**: `npm run eval:live` (`scripts/eval-live.ts`) sent 5 natural-language protection requests — English and Bahasa Malaysia — through `parsePartialIntent`. **4/5 passed** (asset, quantity, and horizon all matched); the one non-pass was a transient Gonka Router 502 (Cloudflare bad-gateway on their edge, not a parsing error) on a retry-worthy request, not a wrong extraction. The offline, network-free intent and grounding evals (`tests/eval/intent-eval.test.ts`, `tests/eval/grounding-eval.test.ts`) are the ones that gate CI.

---

## Questions asked while scoping this project (and the short answers)

**Q: "I still don't understand what is this project about, explain to me in plain text and simple words, and give me an example"**
A: You hold crypto, its price can crash without warning. Payung lets you say "I need this to be worth at least $X by date Y," finds a real offer on a live marketplace that guarantees that, shows you the cost, and executes it for real on Base mainnet. Example: hold 1 ETH worth $2,450, need $2,300 in two weeks, pay a small premium now, and no matter what happens you're guaranteed $2,300 at the deadline.

**Q: "this is just sounds like a stop loss, which currently has this feature, whats so special about this"**
A: A stop-loss is a best-effort order that tries to sell at a trigger price — in a fast crash it can fill well below that price because the order book is thin at that exact moment, which happens constantly in crypto. This is a contractual floor that's computed at a deadline, not executed into a live market, so it can't suffer that slippage. It also doesn't take you out of your position — you keep the asset and any recovery, whereas a triggered stop-loss sells you out and you miss the bounce.

**Q: "What do you mean never sold your ETH? If the price dips to 2300, why? Because you can choose to not sell?"**
A: There's no choice involved because there's no selling at all — the put is a separate, cash-settled side contract that never touches your real ETH. It automatically pays you cash equal to the difference between the floor and the market price at the deadline, and your actual ETH sits untouched in your wallet the entire time.

**Q: "the $4.62 is that a real figure price? What is that price? Will the price be higher than 4.62 until it does not make sense to buy it at all?"**
A: Yes, real, pulled from the live Thetanuts orderbook on Base — though the first example mismatched a strike and its premium, corrected in the pricing table above. The price climbs the closer your floor is to the current market price, roughly 10x from a far-out floor to a near-the-money one, because a closer floor is more likely to actually pay out. There is a real ceiling: once the premium eats a large share of what you're protecting, you're better off not buying it — you'd be paying more for the insurance than the insurance is worth.

**Q: "If the premium right now is $10 for 'I have 1 ETH. I need it to be worth at least $2,300 in 14 days', will the $10 premium become $20 if the ETH amount becomes 2 ETH?"**
A: It depends on the protection goal:
- **Protecting 2 ETH at $2,300 each (total $4,600 floor):** Yes, exactly $20. Option contracts scale linearly with underlying asset quantity ($2 \text{ ETH} \times \$10/\text{ETH} = \$20$).
- **Protecting 2 ETH for a total portfolio floor of $2,300 ($1,150 per ETH):** No, it will be significantly cheaper (close to $0–$2 total). Because a $1,150 strike is much further out-of-the-money (OTM), the probability of dropping that low is minimal, so the premium drops sharply.

---

## Status

- [x] Execution core (`src/core.ts`) — read/write client, live book fetch, quote, free simulation, execute, payoff curve
- [x] CLI for manual verification (`src/cli.ts`) — `book`, `whoami`, `quote`, `simulate`, `execute`
- [x] Verified against live Base mainnet: real orders, real prices, free simulation working
- [x] Aave USDC → aBasUSDC deposit helper (needed since buyable puts settle in aBasUSDC, not raw USDC)
- [x] Natural-language intent → constraint parsing (Track 02 face)
- [x] Consumer UI: floor picker, payoff chart, plain-language pricing explainer (Track 01 face)
- [ ] First real on-chain fill, executed and recorded (BaseScan hash) — the gate that gets crossed once, on camera
- [ ] Demo video + README + docs for submission
