/**
 * Day 1 CLI. Get a real transaction hash before you write a single line of UI.
 *
 *   npm run book                      # what's live right now
 *   npm run quote -- 2400 10          # price a $2400 floor with 10 USDC
 *   npm run whoami                    # check your burner wallet balances
 *   npm run simulate -- 2400 10       # FREE dry run of the real transaction
 *   npm run execute -- 2400 10        # spends real USDC on Base mainnet
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import {
  readClient, writeClient, getBook, findCandidates, quote,
  simulate, execute, payoffCurve, USDC_DECIMALS, coverageGapDays,
} from './core.js';

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
      const usdc = client.chainConfig.tokens.USDC.address;
      const bal = await client.erc20.getBalance(usdc, addr);
      const eth = await client.provider!.getBalance(addr);
      console.log(`\naddress   ${addr}`);
      console.log(`USDC      ${(Number(bal) / 10 ** USDC_DECIMALS).toFixed(4)}`);
      console.log(`ETH (gas) ${ethers.formatEther(eth)}`);
      console.log(`\nexplorer  https://basescan.org/address/${addr}\n`);
      break;
    }

    case 'quote':
    case 'simulate':
    case 'execute': {
      const floorUsd = Number(args[0] ?? 2400);
      const collateral = Number(args[1] ?? 10);

      const spec = { asset: 'ETH', floorUsd, horizonDays: 7 } as const;
      const candidates = await findCandidates(spec, readClient());
      if (!candidates.length) {
        console.log('No fillable structure matches that constraint right now.');
        console.log('(This is the correct answer. Do not let the agent improvise one.)');
        return;
      }

      console.log(`\nCandidates for a ${usd(floorUsd)} floor on ETH:\n`);
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

      console.log(`\nMAX LOSS (you buy): what leaves your wallet today, and nothing more —`);
      console.log(`the exact debit is read from the fill receipt's Transfer logs on execute.\n`);

      if (cmd === 'quote') break;

      console.log('Simulating the real transaction (free)...');
      const sim = await simulate(pick, q.spendUsdc);
      console.log(sim.ok ? '  ✓ would succeed' : `  ✗ would revert: ${sim.error}`);
      if (!sim.ok || cmd === 'simulate') break;

      console.log('\n*** SPENDING REAL USDC ON BASE MAINNET ***');
      const res = await execute(pick, q.spendUsdc);
      console.log(`\n  tx    ${res.hash}`);
      console.log(`  paid  ${usd(res.paidUsd)}  <- read from Transfer logs; this is the max-loss number to say on stage`);
      console.log(`  ->    ${res.explorer}\n`);
      console.log('Put that URL on screen during the pitch.\n');
      break;
    }

    default:
      console.log('commands: book | whoami | quote | simulate | execute');
      console.log('  npm run book');
      console.log('  npm run quote -- 2400 10');
      console.log('  npm run simulate -- 2400 10');
      console.log('  npm run execute -- 2400 10');
  }
}

main().catch((e) => {
  console.error('\nERROR:', e?.shortMessage || e?.message || e);
  process.exit(1);
});
