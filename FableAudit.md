# Payung — audit and honest review

**Verdict up front: yes, it's doable — and it's an unusually well-de-risked hackathon plan.** The part that kills most hackathon DeFi projects (the SDK actually working against live mainnet) is already built and verified in [core.ts](src/core.ts). The idea itself survives the audit. But I found two real bugs in the load-bearing code path, one internal contradiction that would kill your demo as currently written, and two places where your pitch overclaims in ways an options-literate sponsor judge will punish. Here's the attack, ranked by severity.

---

## Attack 1 — Your own "confirmed facts" contradict your own code (demo-killer)

PROJECT.md line 169 says: *"No buyable puts are collateralized in raw USDC — they settle in aBasUSDC."* But [core.ts:145](src/core.ts:145) filters candidates to **raw USDC only** (`c.collateralToken.toLowerCase() === usdc`). If your confirmed fact still holds, `findCandidates()` returns an **empty list for every single protection query** — the CLI prints "No fillable structure matches" and your entire demo path is dead. One of the two is stale: either the fact predates a book change, or the filter was added after your validation run. Meanwhile the Aave deposit helper — the prerequisite for actually holding aBasUSDC — is an unticked TODO sitting directly on the critical path to your on-camera trade. Reconcile this before doing anything else: widen the filter to include `aBasUSDC` (it's still dollar-denominated, which is all your comment says you want) and build the deposit helper first.

## Attack 2 — `spec.asset` is decorative: you never filter by underlying

`ProtectionSpec` accepts `asset: 'ETH' | 'BTC'`, but `findCandidates()` ([core.ts:129](src/core.ts:129)) never checks the underlying — it filters puts, side, collateral, expiry, then ranks by strike distance. The SDK's own docs say the book is multi-asset (its `fetchOrders` comment literally says "Filter by asset using rawApiData," and the RFQ types list ETH, BTC, SOL, DOGE, XRP, BNB, PAXG, AVAX). Strike-distance ranking is not a safe proxy: with a thin ETH-put book, a SOL put at a $200 strike is "only" $2,100 away from a $2,300 ETH floor and can enter your top 8. Your product could sell someone protection **on the wrong asset**. This is a correctness bug in the one function whose integrity is your whole pitch.

## Attack 3 — "Who posts what" is unresolved, and it's the first question an options judge asks

Your CLI prints `collateral ← posted upfront by you` and `MAX LOSS: bounded by collateral posted` unconditionally ([cli.ts:81-90](src/cli.ts:81)) — with a comment admitting it's unverified. For a **bought** put, max loss is the premium; the *writer* posts collateral. The SDK docs are genuinely ambiguous here (preview calls the amount "collateral to spend," `fillOrder` calls it "USDC to spend," and `calculateNumContracts = amount / pricePerContract` implies it's premium-denominated for buyers). Your positioning line is "we understand the primitive, everyone else doesn't." Saying the wrong max-loss on stage to a Thetanuts judge single-handedly refutes your own pitch. Resolve it empirically before the demo: simulate from a wallet holding exactly $X and observe what actually transfers.

## Attack 4 — The promise is "your constraint, satisfied"; the code quietly satisfies a different constraint

`findCandidates()` accepts expiries from **0.6× to 2.5×** of the requested horizon. "I need $2,300 in two weeks" can silently return an 8.7-day put — your floor evaporates five days before the user's stated deadline, which falsifies the one-liner. Either surface the mismatch loudly in the UI ("this floor ends March 3rd — 5 days short of what you asked"), or use the escape hatch the protocol hands you: the SDK has an **RFQ builder** that requests a quote for the *exact* underlying/strike/expiry/PUT/`isLong: true` you need when the book has no match. That converts your weakest structural point (inventory you don't control) into a demo beat ("the book didn't have your floor, so we asked the market to make one"). RFQ is async with offer deadlines, so treat it as a stretch goal — but the honesty fix in the UI is mandatory.

## Attack 5 — The stop-loss table overclaims: you protect a *date*, not the *path*

Thetanuts options are cash-settled **at expiry**. Your plain-language sections say this correctly ("at the deadline"), but the comparison table claims "floor holds exactly at the crash's worst moment" — false if the crash happens mid-window and recovers by expiry: the put pays zero. A stop-loss protects continuously (badly); a European put protects one date (exactly). A judge who trades will land this punch. Fix the table, then *own* the framing, because it's actually your stronger pitch: real constraints have dates — tuition due, loan due. Also add the other honest row the table omits: stop-losses are free, puts cost premium (you already have the 5–10% rule in the doc; put it in the comparison before someone else does).

## Attack 6 — Track 02 skepticism: "where's the AI?"

"The LLM never generates a number" is correct engineering and a great line — but it means the visible AI surface is intent parsing, which a skeptic calls a form with extra steps. Make the agent's *judgment* the star: comparing candidates, the premium-vs-value call ("this floor costs 8% of what it protects — take the $2,150 floor at $5 instead"), refusing bad buys, and honestly saying "nothing fillable matches." That judgment is already written in your own "where it stops making sense" section — put it on screen. Bonus: Gonka Router is itself a MUBA sponsor (the sponsor list is Sui, Thetanuts, GonkaRouter, per the event's public listings) — say so out loud.

## Attack 7 — Two-track and rules risks

- **Confirm one project can enter both tracks.** The site says teams "select sponsor tracks" (plural, promising), but if the rules force one, you need to know now, not at submission.
- **Don't build two apps.** Two faces = double the polish surface in an ~11-day window. Build one web app where the chat agent is the front door and the floor-picker/payoff chart is the body; pitch it twice with different emphasis.
- Registration is on a countdown and eligibility is Malaysian citizens/residents — make sure you're actually registered on Devfolio.
- The project isn't a git repo yet; submissions need one. Init now, commit as you go.

## Attack 8 — Demo-day operational reality

You observed the book move 342→403 orders in one session; the order you rehearse **will** be gone at pitch time and `fillOrder` will revert on stage. The bar is "at least one real trade," not "a live trade during the pitch" — so execute the real fill *before* the pitch, have the BaseScan link ready, and attempt a live fill as theater with 2–3 fallback candidates and a `callStatic` immediately before sending. Use a paid RPC (public `mainnet.base.org` + venue wifi is how demos die), and record a backup video.

---

## What survives the attack (and it's a lot)

- **The instrument is correct for the stated problem** — that's rarer than it sounds, and your anti-prediction positioning ("the field will be 'AI predicts, AI buys calls'") is sharp and almost certainly accurate about the competition.
- **The hard 60% is done and verified.** Fetch → quote → free simulation → execute exists, and the documented gotchas (price *scale* not decimals, `isBuyer` semantics, per-order collateral tokens) match the SDK's actual typings — I checked; the `isLong → !isBuyer` mapping and passing the full `fetchOrders()` item into `previewFillOrder` are both right.
- **Your pricing table is plausible.** I sanity-checked it against Black-Scholes at IV ≈ 0.5, spot $2,450, 8.7 days: your $19.94 for the $2,300 floor is in the right range. These aren't invented numbers.
- **Competition math is believable**: a mainnet-execution gate plus options literacy genuinely thins a student field to a handful of teams per track.

**Doability:** the remaining work is the easy-but-time-consuming 40% — Aave helper (small), NL parsing (small; it's one JSON extraction), the UI (your real time sink), and the video. That fits the window *if* you take the one-app-two-pitches route. Priority order: fix Attack 1 and get a real fill on-chain this week — everything else is polish on top of a proven pipeline.

Sources: [MUBA hackathon listing (dev.events)](https://dev.events/hackathons/AS/MY/it), [mubahack.xyz](https://www.mubahack.xyz/)