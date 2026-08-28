# Payung — demo runbook

The bar is "at least one real trade against live pricing" — not "a live trade during the pitch."
The banked trade is the submission; the live attempt is theater.

## Days before

- [ ] `BASE_RPC_URL` in `.env` is a paid/free-tier Alchemy or Infura key — NOT `mainnet.base.org`,
      and NOT venue wifi + public RPC (that combination is how demos die).
- [ ] Burner wallet holds ~$20 USDC + ~$1 of ETH gas on Base. `npm run whoami` to confirm.
- [ ] **Execute the banked trade:** `npm run preflight -- 1 2300 14`, pick the top ✓ candidate,
      then run the full flow in the web app (or `npm run execute -- 1 2300 10`) and SAVE:
      - the BaseScan URL,
      - the "you paid $X" figure (from Transfer logs — this is the max-loss number),
      - a screen recording of the whole flow, NL sentence → hash (this is the backup video).
- [ ] Paste the hash + paid figure into README.md ("Proof" section).
- [ ] Confirm on Devfolio: registration done. Submit the one entry to BOTH tracks —
      the sponsor's workshop deck says explicitly: "Nothing stops one entry taking both
      tracks. If we're happy with it, you can win both."

## The pitch, in order

Judging (per the sponsor's workshop deck) scores exactly two things — "Does it work?" and
"Would anyone actually use it?" — not complexity, not the tech stack. So lead with the
user (tuition-due student burned by a stop-loss), end with the working product and the
hash, and close with "we plan to keep building this" (they explicitly support post-hackathon teams).

1. Say the positioning line (PROJECT.md "The pitch") — including that Gonka Router, our AI layer, is itself a MUBA sponsor.
2. Type the constraint in plain English. Show the parse — the AI's ONLY job.
3. Show live candidates + agent verdict (premium-vs-value judgment, coverage-gap honesty).
4. Show the payoff curve. Say the max-loss line: "what leaves the wallet today, nothing more."
5. Simulate — free, against current chain state.
6. Attempt the live fill. If it succeeds: fresh hash on screen. If the order was taken:
   say "the book moved — which is why every number here is live" and show the banked
   BaseScan link. Either way you end on a real hash.

## Minutes before

- [ ] `npm run preflight -- <quantity> <floorTotal> <days>` — confirms RPC latency and 3 fillable fallbacks.
- [ ] Web app running (`npm run web`), page loaded, wallet funded.
- [ ] Backup video open in a tab.

## If everything is on fire

The banked BaseScan link and the recording ARE the demo. A verified mainnet transaction
hash needs no live wifi to be convincing.
