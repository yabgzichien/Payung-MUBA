/**
 * Day 1 CLI. Get a real transaction hash before you write a single line of UI.
 *
 *   npm run book                              # what's live right now
 *   npm run quote -- 1 2300 10 14             # price "1 ETH, $2300 total floor" with 10 USDC, 14d horizon (default 14)
 *   npm run whoami                             # check your burner wallet balances
 *   npm run deposit -- 12                      # top up aBasUSDC via Aave if short
 *   npm run simulate -- 1 2300 10 14           # FREE dry run of the real transaction
 *   npm run execute -- 1 2300 10 14            # spends real USDC on Base mainnet
 *
 * quantity defaults to 1, floorTotal to 2300, and horizonDays to 14 on
 * quote/simulate/execute — the same defaults `preflight` uses, so a
 * candidate vetted with `preflight` is the same candidate `execute` will
 * pick when run with no arguments. The strike matched against is DERIVED
 * (floorTotal / quantity) — see impliedStrike() in core.ts; there is no
 * separate per-unit-price argument.
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import {
  readClient, writeClient, getBook, findCandidates, quote,
  simulate, execute, payoffCurve, USDC_DECIMALS, coverageGapDays,
  collateralDecimals, dollarTokens, tokenSymbol, impliedStrike,
} from './core';
import { judgeQuote } from './judgment';
import { ensureDollarCollateral } from './aave';
import { parseIntent, gonkaLlm } from './intent';
import { commitmentFor, writeCommitment } from './commitments';

const [cmd, ...args] = process.argv.slice(2);
const usd = (n: number) => `$${n.toFixed(2)}`;

function show(c: any, i: number) {
  const g = c.greeks;
  console.log(
    `  [${i}] ${c.isCall ? 'CALL' : 'PUT '} strike ${usd(c.strike).padEnd(9)} ` +
    `exp ${c.expiry.toISOString().slice(0, 10)} (${c.daysToExpiry.toFixed(1)}d)  ` +
    `px ${c.pricePerContract.toFixed(4).padEnd(9)} ` +
    `iv ${g.iv?.toFixed(3) ?? '—'}  delta ${g.delta?.toFixed(4) ?? '—'}  ` +
    `| ${c.yourSide}`
  );
}

async function main() {
  switch (cmd) {
    case 'book': {
      const book = await getBook();
      const puts = book.filter((c) => !c.isCall);
      console.log(`\n${book.length} live orders on Base (${puts.length} puts)\n`);
      book.slice(0, 15).forEach(show);
      break;
    }

    case 'whoami': {
      const client = writeClient();
      const addr = await client.getSignerAddress();
      const eth = await client.provider!.getBalance(addr);
      console.log(`\naddress   ${addr}`);
      console.log(`ETH (gas) ${ethers.formatEther(eth)}`);

      const book = await getBook(client);
      const dollarSet = await dollarTokens(client, book);
      for (const t of dollarSet) {
        const sym = await tokenSymbol(client, t);
        const d = await collateralDecimals(client, t);
        try {
          const b = await client.erc20.getBalance(t, addr);
          console.log(`${sym.padEnd(9)} ${(Number(b) / 10 ** d).toFixed(4)}`);
        } catch {
          console.log(`${sym.padEnd(9)} 0.0000 (RPC retry skipped)`);
        }
      }

      console.log(`\nexplorer  https://basescan.org/address/${addr}\n`);
      break;
    }

    case 'deposit': {
      // npm run deposit -- 15   -> ensure the wallet holds 15 aBasUSDC-equivalents
      const amountUsdc = Number(args[0] ?? 15);
      const client = writeClient();
      const book = await getBook(client);
      // Run buyable puts through the SAME dollar-collateral filter findCandidates()
      // uses, not the raw book — otherwise this can pick a WETH/cbBTC-collateralized
      // order and crash into planDeposit's generic "no auto-deposit path" reason.
      const dollarSet = await dollarTokens(client, book);
      const target = book.find((c) => !c.isCall && c.takerIsBuyer && dollarSet.has(c.collateralToken.toLowerCase()));
      if (!target) { console.log('No buyable, dollar-collateralized puts on the book to read a collateral token from.'); return; }
      const dec = await collateralDecimals(client, target.collateralToken);
      const units = BigInt(Math.round(amountUsdc * 10 ** dec));
      console.log(`Ensuring ${amountUsdc} of ${target.collateralToken} (the live book's buyable-put collateral)...`);
      const res = await ensureDollarCollateral(client, target.collateralToken, units);
      console.log(res.deposited ? `Deposited via Aave: https://basescan.org/tx/${res.hash}` : 'Already sufficient — nothing to do.');
      break;
    }

    case 'quote':
    case 'simulate':
    case 'execute': {
      const quantity = Number(args[0] ?? 1);
      const floorTotalUsd = Number(args[1] ?? 2300);
      const collateral = Number(args[2] ?? 10);
      const horizonDays = Number(args[3] ?? 14);

      const spec = { asset: 'ETH' as const, quantity, floorTotalUsd, horizonDays };
      const strike = impliedStrike(spec);
      const candidates = await findCandidates(spec, readClient());
      if (!candidates.length) {
        console.log('No fillable structure matches that constraint right now.');
        console.log('(This is the correct answer. Do not let the agent improvise one.)');
        return;
      }

      console.log(`\nCandidates for ${quantity} ETH needing ${usd(floorTotalUsd)} total (implied strike ${usd(strike)}):\n`);
      candidates.forEach(show);

      const pick = candidates[0];
      const gap = coverageGapDays(pick, spec);
      if (gap > 0.25) {
        console.log(
          `\n⚠ COVERAGE GAP: this floor ends ${pick.expiry.toISOString().slice(0, 10)} — ` +
          `${gap.toFixed(1)} days BEFORE your stated deadline. After that date you are unprotected.`
        );
      }
      const q = await quote(pick, collateral, readClient());

      console.log(`\n── Quote ────────────────────────────────`);
      console.log(`side          ${q.yourSide.toUpperCase()}`);
      console.log(`strike        ${usd(q.strike)}`);
      console.log(`expiry        ${q.expiry.toISOString().slice(0, 16).replace('T', ' ')}`);
      if (q.capped) {
        console.log(`you spend     ${usd(q.spendUsdc)}  (capped — maker can only absorb ${usd(q.spendUsdc)} of your requested ${usd(q.requestedUsdc)})`);
      } else {
        console.log(`you spend     ${usd(q.spendUsdc)}`);
      }
      console.log(`premium       ${usd(q.premiumUsdc)}`);
      console.log(`contracts     ${q.numContracts} (raw)`);

      const curve = payoffCurve(q, [q.strike * 0.85, q.strike * 1.15], 6);
      console.log(`\npayoff:`);
      curve.forEach((p) => console.log(`  spot ${usd(p.spot).padEnd(10)} pnl ${usd(p.pnl)}`));

      const j = judgeQuote(q, gap);
      console.log(`\nagent verdict: ${j.verdict.toUpperCase()}`);
      j.reasons.forEach((r) => console.log(`  · ${r}`));

      console.log(`\nMAX LOSS (you buy): what leaves your wallet today, and nothing more —`);
      console.log(`the exact debit is read from the fill receipt's Transfer logs on execute.\n`);

      if (cmd === 'quote') break;

      console.log('Simulating the real transaction (free)...');
      const sim = await simulate(pick, q.spendUsdc);
      console.log(sim.ok ? '  ✓ would succeed' : `  ✗ would revert: ${sim.error}`);
      if (!sim.ok || cmd === 'simulate') break;

      const wclient = writeClient();
      const dec = await collateralDecimals(wclient, pick.collateralToken);
      await ensureDollarCollateral(wclient, pick.collateralToken, BigInt(Math.round(q.spendUsdc * 10 ** dec)));

      console.log('\n*** SPENDING REAL USDC ON BASE MAINNET ***');
      const res = await execute(pick, q.spendUsdc);
      console.log(`\n  tx    ${res.hash}`);
      console.log(
        res.paidUsd === null
          ? `  paid  UNKNOWN — verify the debit on BaseScan before reporting a max-loss figure`
          : `  paid  ${usd(res.paidUsd)}  <- read from Transfer logs; this is the max-loss number to say on stage`
      );
      console.log(`  ->    ${res.explorer}\n`);
      console.log('Put that URL on screen during the pitch.\n');

      // execute()'s return doesn't surface a clean on-chain option contract
      // address (receipt is `any`, and the SDK's documented FillOrderResult
      // shape isn't verified against this codebase's own fill-safety tests —
      // see fill-safety.test.ts's fillOrder mock, which models only
      // { hash, logs }). Use the order's signature instead: it's already the
      // stable per-order identifier this codebase relies on elsewhere
      // (api-shared.ts's candidateId, ranking.test.ts) for exactly this kind
      // of "which order was this" bookkeeping.
      writeCommitment(commitmentFor(
        spec, res.hash, pick.raw?.signature ?? 'unknown',
        q.strike, q.expiry.toISOString(), q.contracts, new Date()
      ));
      break;
    }

    case 'preflight': {
      // Run minutes before the demo: is the pipeline alive, and which candidates are actually fillable RIGHT NOW?
      const spec = {
        asset: 'ETH' as const,
        quantity: Number(args[0] ?? 1),
        floorTotalUsd: Number(args[1] ?? 2300),
        horizonDays: Number(args[2] ?? 14),
      };
      const t0 = Date.now();
      const candidates = await findCandidates(spec);
      console.log(`\nbook+filter latency ${Date.now() - t0}ms · ${candidates.length} candidates for $${spec.floorTotalUsd} total on ${spec.quantity} ETH / ${spec.horizonDays}d`);
      if (!candidates.length) { console.log('NO CANDIDATES — adjust the demo constraint before going on stage.'); return; }
      for (const c of candidates.slice(0, 3)) {
        const sim = await simulate(c, 10);
        const gap = coverageGapDays(c, spec);
        console.log(
          `  strike ${usd(c.strike)} exp ${c.expiry.toISOString().slice(0, 10)}` +
          `${gap > 0.25 ? ` (ends ${gap.toFixed(1)}d early)` : ''}: ` +
          (sim.ok ? '✓ fillable right now' : `✗ ${sim.error}`)
        );
      }
      console.log('\nUse the top ✓ candidate on stage; the other two are your fallbacks.\n');
      break;
    }

    case 'ask': {
      // npm run ask -- "I have 1 ETH and need it worth at least $2,300 in two weeks"
      const text = args.join(' ');
      if (!text) { console.log('usage: npm run ask -- "your constraint in plain words"'); return; }
      const spec = await parseIntent(text, gonkaLlm());
      console.log(`\nParsed: protect ${spec.quantity} ${spec.asset} at a $${spec.floorTotalUsd} total floor for ${spec.horizonDays} days (implied strike $${impliedStrike(spec).toFixed(2)})\n`);
      const candidates = await findCandidates(spec);
      if (!candidates.length) {
        console.log('No fillable structure matches that constraint right now.');
        console.log('(This is the correct answer. The agent does not improvise one.)');
        return;
      }
      candidates.forEach(show);
      break;
    }

    case 'agent': {
      const { newAgentState, runAgentTurn } = await import('./agent.js');
      const { gonkaChat } = await import('./chat.js');
      const { TOOLS } = await import('./tools.js');
      const readline = await import('node:readline/promises');

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const chat = gonkaChat();
      let state = newAgentState();
      // Simulation needs an address; reuse the burner's if one is configured.
      try {
        const { signerFromEnv, readClient } = await import('./core.js');
        state.ctx.signerAddress = signerFromEnv(readClient().provider).address;
      } catch {
        // No key configured — simulate_fill will decline politely. Not fatal.
      }

      console.log('Payung agent. Say what you are afraid of losing. Ctrl-C to quit.\n');
      for (;;) {
        const line = (await rl.question('> ')).trim();
        if (!line) continue;
        // A single turn failing (network blip, Gonka rate limit, etc.) must not
        // kill the whole session — only this specific call is guarded, so
        // Ctrl-C / readline's own error handling is untouched. `state` from
        // before the failed turn is kept as-is so the user can just retry.
        try {
          state = await runAgentTurn(state, line, chat, TOOLS);
          console.log(`\n${state.reply}\n`);
          for (const v of state.violations) {
            console.log(`  [guard] blocked ungrounded numbers: ${v.tokens.join(', ')}`);
          }
        } catch (e: any) {
          console.log(`\n[error] ${e?.shortMessage || e?.message || String(e)} — try again.\n`);
        }
      }
    }

    default:
      console.log('commands: book | whoami | deposit | quote | simulate | execute | preflight | ask | agent');
      console.log('  npm run book');
      console.log('  npm run quote -- 1 2400 10 14        # <quantity> <floorTotalUsd> <collateralUsdc> [horizonDays]');
      console.log('  npm run simulate -- 1 2400 10 14');
      console.log('  npm run execute -- 1 2400 10 14');
      console.log('  npm run deposit -- 12');
      console.log('  npm run preflight -- 1 2300 14        # <quantity> <floorTotalUsd> [horizonDays]');
      console.log('  npm run ask -- "I have 1 ETH and need it worth at least $2,300 in two weeks"');
      console.log('  npm run agent                          # interactive agent loop');
  }
}

main().catch((e) => {
  console.error('\nERROR:', e?.shortMessage || e?.message || e);
  process.exit(1);
});
