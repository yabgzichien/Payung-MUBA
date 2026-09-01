# ☂ Payung

*Payung* — Malay for "umbrella." You buy protection before it rains.

Tell it what you're afraid of losing, in plain language. It finds a real, currently-fillable
put option on the live Thetanuts orderbook on **Base mainnet**, shows you exactly what the
floor costs using the protocol's own pricing math, simulates the exact transaction for free,
and — only after you confirm — executes it for real and hands you the BaseScan hash.

Built for **MUBA Hacks 2026** — Thetanuts Track 01 (SDK Product) and Track 02 (AI × Options).

## Proof (Track 02 bar: at least one real trade against live pricing)

- Transaction: _[run the demo runbook's "Days before" checklist with a funded burner wallet, then paste the BaseScan URL here]_
- Paid: _[paste the "you paid $X" figure from the fill receipt's Transfer logs here — this is also the buyer's max loss]_

## Why the options are load-bearing

A put option is the *correct instrument* for "I need my ETH worth at least $X by date Y":
a cash-settled contractual floor computed at a deadline. It cannot slip the way a stop-loss
fills below its trigger in a thin book, and it never touches the user's actual coins. Stub
out the Thetanuts calls and there is no product — every candidate, premium, and payoff
figure comes from `fetchOrders()` / `previewFillOrder()` live.

## Who it's for

Crypto holders with a hard deadline and a hard floor — tuition due, loan due — who have
been burned by stop-losses or don't want to learn options jargon to protect themselves.

## The AI (and what it is not allowed to do)

The LLM (Gonka Router — a MUBA sponsor) does exactly one job: transcribe a sentence into
`{asset, quantity, floorTotalUsd, horizonDays}`, strictly validated. It is explicitly
forbidden from dividing or multiplying — the per-unit strike a match is ranked against is
derived in tested code (`impliedStrike`), never by the model. It never generates a price, a
prediction, or any number the user sees. The agent's *judgment* — premium-vs-value verdict,
coverage-gap warnings, refusing to improvise when nothing on the book fits — is computed
deterministically from live data (`src/judgment.ts`).

## Run it

```bash
npm install
cp .env.example .env   # burner wallet key + Alchemy/Infura Base RPC + Gonka key
npm test               # pure-function tests, no network
npm run book           # live orderbook (read-only)
npm run ask -- "I have 1 ETH and need it worth at least $2,300 in two weeks"
npm run web            # http://localhost:8787 — the full product
```

Execution path safeguards: buyable-puts-only filter (you can never accidentally write
options), underlying-asset filter, maker-budget capping (never silent), order-staleness
guard, free `callStaticFillOrder()` before every real send, exact-amount approvals,
automatic USDC→aBasUSDC Aave deposit when an order needs it.

**Wallet requirement, precisely:** browsing the live book, asking in plain language,
viewing candidates, and getting a quote + payoff chart all work with zero wallet
setup. Simulating a fill and executing one both require a funded burner wallet's
`PRIVATE_KEY` in `.env` — even the "free" simulate step calls `callStaticFillOrder()`,
which needs a signer address to run against, so it is free of cost but not free of
wallet setup.

## Architecture

One core (`src/core.ts`) is the only module that touches Thetanuts. The CLI (`src/cli.ts`),
the HTTP API (`app/api/*/route.ts`), and the web UI (`app/`) are thin faces over it.
Spec: [Payung_Spec.md](Payung_Spec.md) · Pitch & Q&A: [PROJECT.md](PROJECT.md)

## MCP server

Payung's tool registry (`src/tools.ts` — the same `get_spot`, `find_protection`, `quote_candidate`,
`judge_candidate`, `payoff_at`, `list_positions`, `simulate_fill`, `propose_execution` set the agent
pane calls) is also exposed as a standard MCP stdio server, so any MCP-speaking client (Claude
Desktop, the MCP Inspector, etc.) can drive it directly:

```bash
npm run mcp                                          # start the stdio server directly
npx @modelcontextprotocol/inspector npx tsx mcp/server.ts   # or drive it through the Inspector
```

Point a client at it by running `npx tsx mcp/server.ts` (or `npm run mcp`) as the command, with
this repo's `.env` present so it can reach the live Base RPC. Every tool call is served by the
exact same `ToolDef.run()` used by the agent and the watcher — one registry, three surfaces —
so the MCP adapter inherits the same live pricing and the same safety filters instead of
reimplementing them.

**Why this isn't built on `@thetanuts-finance/mcp`:** that server exposes a generic surface over
the Thetanuts orderbook that permits *writing* options — selling collateralized puts — which is
the one action a Payung user must never take by accident; Payung only ever buys protection. This
adapter instead wraps Payung's own registry, which has already applied the buyable-puts-only,
correct-underlying, and dollar-collateral filters before any tool schema is generated, so those
guarantees carry over for free. No tool in the registry — over MCP or otherwise — ever signs or
sends a transaction: `propose_execution` is the terminal action, and it only hands back an
unsigned proposal for the user's own wallet to review and sign.

## After the hackathon

We plan to keep building this: roadmap is an autonomous re-hedge agent (watch a position,
roll protection as expiries pass — Track 02's "autonomous hedging" idea, deliberately
scoped out of the hackathon build) and RFQ support for exact strikes/expiries when the
book has no match.
