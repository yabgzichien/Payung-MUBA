
[**A1) Problem statement	1**](#a1\)-problem-statement)

[Why Crypto?	1](#why-crypto?)

[Why start with BTC and ETH (MVP)?	2](#why-start-with-btc-and-eth-\(mvp\)?)

[Hence, the Problem Statement is:	4](#hence,-the-problem-statement-is:)

[**A2) Solution- Payung	4**](#a2\)-solution--payung)

[Track 1：SDK Product	4](#track-1：sdk-product)

[Track 2 ： AI × Options	5](#track-2-：-ai-×-options)

[**A3) Competitive landscape	5**](#a3\)-competitive-landscape)

[**A4)Business model	6**](#a4\)business-model)

[**A5)Post-hackathon Roadmap	6**](#a5\)post-hackathon-roadmap)

***A1,A3-A5 are universal for Track 1 & Track 2***  
***\* \=may need amendments after the final software implementation is confirmed.*** 

# A1) Problem statement 

## **Why Crypto?**

1. **Crypto Market**

“Cumulative volume totaled US$35.08 trillion, or US$193.8 billion per day; on the same basis, volume was US$41.60 trillion in the same period of 2025, ” – CoinGlass 2026

Analyst summary : Despite a 15.7% year-on-year decline, crypto derivatives remained a major component of the market, recording US$35.08T in H1 2026\. This shows that derivatives are already an established and highly active part of the crypto market. 

2.  **Liquidations \- this is extra, not necessarily to be included in the Pitch Deck**

H1 2025: Largest single-day event: \~US$2.23B

H1 2026: Largest single-day event: \~US$2.588B

Analyst summary : Large liquidation events continue to occur during periods of market stress. This highlights how quickly downside market movements can force large positions to be unwound. 

All Statement & diagram above r derived from: 

[https://www.coinglass.com/learn/semi-annual-outlook-en](https://www.coinglass.com/learn/semi-annual-outlook-en)

[https://www.coinglass.com/learn/2026h1-market-report-en](https://www.coinglass.com/learn/2026h1-market-report-en)?

## **Why start with BTC and ETH (MVP)?**

1. **BTC/ETH Market Cap out of all crypto** 

![][image1]

reference：[https://coinmarketcap.com/historical/20260824/](https://coinmarketcap.com/historical/20260824/)?

Total crypto market cap: $2.65T 

BTC dominance: $1.585T (59.7%)

ETH dominance: $299.51B (11.3%)

Analyst summary : BTC and ETH were the two dominant crypto assets by market capitalisation \~71.0% of total crypto market cap on latest 24 August 2026

2. **BTC/ETH Derivatives Market Infrastructure** 

![][image2]

“BTC executable liquidity for large orders remained concentrated on a small number of leading venues. ” – CoinGlass 2026

Analyst summary :  BTC and ETH have substantial observable derivatives liquidity across major venues. This makes BTC and ETH practical initial assets for an options-based protection product. 

3. **Slippage risk in the existing mechanics**

“When the market reaches your stop price, the order converts into a market order and will fill at current bid or ask price. The fill is guaranteed, but the exact price is not.” 

“The price difference between your stop price and your actual fill price is slippage. ”  
– reference：[coinbase](https://help.coinbase.com/en/coinbase/derivatives/us-derivatives-manage-order?utm_source=chatgpt.com)

Analyst summary: Stop-loss triggered slippage ：Crypto holders who want to protect the value of their BTC or ETH face a fundamental trade-off. Selling the asset or using a stop-loss can reduce downside exposure, but a stop-loss does not guarantee the final execution price during a rapid market move. At the same time, selling the asset removes the holder's exposure to any subsequent recovery or upside. This creates a protection gap for holders who want to establish a minimum value for their BTC or ETH while continuing to hold the underlying asset. 

                                                                👇 

**Even though options can solve the slippage problem by providing a guaranteed floor without requiring the holder to sell, a gap remains:** 

Based on our research across major on-chain options platforms, we found existing on-chain options infrastructure solves *execution*, but users must still translate a plain protection goal (e.g. 'I don't want ETH to drop below $X before Y date') into specific option parameters — strike, expiry, side, size — before they can act. This technical translation step is itself a barrier for holders who are not options-literate. 

Example of Existing on chain: 

Derive requires users to manually select expiry, strike, option type, size, and limit price, reviewing a payoff graph before submitting. 

## **Hence, the Problem Statement is:**

> Users lack a reliable price floor through conventional exit-based protection (selling or stop-loss), and while cash-settled options can provide that floor without selling the underlying asset, accessing options-based protection remains technically complex for users who simply want to define how much downside they are willing to accept. 

---

# A2) **Solution- Payung** 

Payung’s niche: 

no existing platform lets a holder state a goal like "I need my ETH worth at least $X by date Y" and have that become a real, simulated, on-chain-verifiable put fill. Payung solves the options selection and accessibility problem, not the execution problem. 

## **Track 1：SDK Product**

1\. Objective:

> Build a real, working consumer-facing product meaningfully built on the Thetanuts SDK — turning raw on-chain options infrastructure into an accessible downside-protection tool for BTC/ETH holders, not just an execution layer for professional options traders, without requiring them to manually understand and construct an options trade. 

2\. Target Users：

**MVP: ETH & BTC holders: seeking downside protection through put options.**

（Long-term: crypto holders: not only seeking downside protection, but also other strategies like call options, etc. ）

3.detailed flowchart/event flow:

![][image3]

4\.\***Key features**（Track1 emphasise the Thetanuts SDK applications）：

* Live orderbook query — `fetchOrders()` on Base mainnet, never cached/mocked data  
* Protocol-native pricing — `previewFillOrder()`, no invented numbers  
* Free pre-trade simulation — `callStaticFillOrder()` before any real fund moves  
* Real execution \+ verifiable proof — `fillOrder()` \+ BaseScan transaction hash  
* Collateral handling — auto-detects and routes through Aave for `aBasUSDC` when required  
* Honest failure mode — if no live order matches, Payung says so instead of substituting

5\.**\*Tech stack:** draw a simple tech architecture diagram

---

## **Track 2 ： AI × Options** 

1.obj :   
Build an AI agent that translates a user's natural-language protection goal into a real on-chain options trade, executed against Thetanuts' live pricing, without requiring them to manually understand and construct an options trade. 

2.same as Track1

3\. same as Track1

4\.\***Key features**

* Natural-language intent parsing — extracts asset, floor price, time horizon from a plain sentence  
* AI guardrail — the model never invents a price or predicts market movement; every number comes from a live SDK call  
* End-to-end autonomous pipeline — from parsed intent straight through to an executable, correctly-filtered trade candidate  
* Simulation-before-execution safety check — `callStaticFillOrder()` catches failures before spending real gas  
* Verifiable on-chain proof — a real transaction hash on BaseScan, satisfying the track's "real trade, not testnet" bar

5\.**\*Tech stack:** draw a simple tech architecture diagram

---

# **A3) Competitive landscape** 

What makes Payung different:

| Key Capability | Deribit | Derive | OKX Options | PAYUNG |
| ----- | ----- | ----- | ----- | ----- |
| Options-based downside protection | ✓ | ✓ | ✓ | **✓** |
| Plain-language / AI intent input | ✕ (user configures manually)  | ✕ (user configures manually)  | ✕ (user configures manually)  | **✓ (AI parses intent only; matching, pricing & execution are deterministic protocol calls )** |

Existing platforms: users start from the trade (choose strike, expiry, size themself).

Payung: users start from the goal (state what they want protected; the trade gets configured for them).   
---

# A4)**Business model** 

**Business model: B2C, transaction-based.** The user pays a small, transparent service fee only when a protection trade successfully executes. 

# ---

# **A5)Post-hackathon Roadmap**  

Phase 1 — Validate

* validating it holds up beyond a single scripted run: repeat trades across different strikes/expiries, test with a handful of real BTC/ETH holders (not just the team), and confirm the intent-parsing stays accurate outside the demo's exact wording. 

Phase 2 — Expand

* Wider assets: Support more underlying assets beyond the ETH/BTC MVP.  
* Flexible scenarios: Enable multiple strikes and expiries rather than a single best-fit match.  
* Monitoring: Add position and expiry tracking so users avoid manual checks.  
* Automated settlement: Confirm if Thetanuts puts pay out automatically. If manual, build auto-claiming to prevent inaction losses (addressing the flagged technical dependency).

Phase 3 — Evolve

* Portfolio management: Scale from single-position protection to portfolio-level risk management.  
* Advanced strategies: Introduce call options and broader strategies beyond downside protection.  
* Broader audience: Target long-term crypto holders broadly, not just ETH/BTC holders.  
* B2B extension (Optional): Explore licensing the intent-parsing layer to wallets or other protocols.

\*\*Extra: Thetanuts is European Options (European-Styled,not US-styled)= Options cannot be exercised early at any time; they can only be settled collectively at the exact moment of the expiration date (Expiry).
