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
  simulate, execute, payoffCurve, USDC_DECIMALS,
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

      const candidates = await findCandidates(
        { asset: 'ETH', floorUsd, horizonDays: 7 },
        readClient()
      );
      if (!candidates.length) {
        console.log('No fillable structure matches that constraint right now.');
        console.log('(This is the correct answer. Do not let the agent improvise one.)');
        return;
      }

      console.log(`\nCandidates for a ${usd(floorUsd)} floor on ETH:\n`);
      candidates.forEach(show);

      const pick = candidates[0];
      const q = await quote(pick, collateral, readClient());

      console.log(`\n── Quote ────────────────────────────────`);
      console.log(`side          ${q.yourSide.toUpperCase()}`);
      console.log(`strike        ${usd(q.strike)}`);
      console.log(`expiry        ${q.expiry.toISOString().slice(0, 16).replace('T', ' ')}`);
      console.log(`collateral    ${usd(q.collateralUsdc)}   <- posted upfront by you`);
      console.log(`premium       ${usd(q.premiumUsdc)}`);
      console.log(`contracts     ${q.numContracts} (raw)`);

      const curve = payoffCurve(q, [q.strike * 0.85, q.strike * 1.15], 6);
      console.log(`\npayoff:`);
      curve.forEach((p) => console.log(`  spot ${usd(p.spot).padEnd(10)} pnl ${usd(p.pnl)}`));

      console.log(`\nMAX LOSS: bounded by collateral posted = ${usd(q.collateralUsdc)}`);
      console.log(`^ VERIFY THIS against the contract before you say it to a judge.\n`);

      if (cmd === 'quote') break;

      console.log('Simulating the real transaction (free)...');
      const sim = await simulate(pick, collateral);
      console.log(sim.ok ? '  ✓ would succeed' : `  ✗ would revert: ${sim.error}`);
      if (!sim.ok || cmd === 'simulate') break;

      console.log('\n*** SPENDING REAL USDC ON BASE MAINNET ***');
      const res = await execute(pick, collateral);
      console.log(`\n  tx  ${res.hash}`);
      console.log(`  ->  ${res.explorer}\n`);
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
