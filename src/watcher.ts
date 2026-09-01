/**
 * The re-hedge watcher.
 *
 * Default mode NOTIFIES: it detects, quotes a replacement, and alerts. The human
 * confirms and signs. --auto executes within declared limits.
 *
 * Runs locally against the burner wallet only. It is never deployed to Vercel,
 * and serverSigningAllowed() is untouched by this module.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readCommitments, deadlineDaysLeft, incrementRolls, DEFAULT_DIR, type Commitment } from './commitments';
import { decideRoll, type RollDecision, type RollPolicy } from './policy';
import { shapeProtection, type ShapedPosition } from './positions';
import {
  readClient, writeClient, findCandidates, quote, simulate, execute,
  collateralDecimals, type Candidate,
} from './core';
import { ensureDollarCollateral } from './aave';

export type AuditEntry = {
  at: string;
  positionId: string | null;
  txHash: string;
  decision: RollDecision;
  policy: RollPolicy;
  replacement?: { strike: number; expiryIso: string; premiumUsd: number } | null;
  simulated?: boolean;
  executedTxHash?: string | null;
  note?: string;
};

export function appendAudit(entry: AuditEntry, dir = DEFAULT_DIR): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'agent-log.jsonl'), `${JSON.stringify(entry)}\n`);
}

export type CycleReport = { checked: number; rolls: number; blocked: number; alerts: string[] };

async function positionsFor(address: string, nowSec: number): Promise<ShapedPosition[]> {
  const client = readClient();
  // Mirror the exact indexer call app/api/positions/route.ts and src/tools.ts's
  // list_positions already make: client.api.getUserPositionsFromIndexer(address),
  // filtered to rows where the caller is buyer or seller.
  const addr = address.toLowerCase();
  const raw: any[] = await client.api.getUserPositionsFromIndexer(address);
  return raw
    .filter((p: any) => {
      const buyer = String(p.buyer ?? '').toLowerCase();
      const seller = String(p.seller ?? '').toLowerCase();
      return buyer === addr || seller === addr;
    })
    .map((p) => shapeProtection(p, nowSec));
}

/** Find the best replacement for an expiring commitment, using the same filters as everything else. */
async function findReplacement(c: Commitment, now: Date): Promise<{ candidate: Candidate; premiumUsd: number } | null> {
  const daysLeft = deadlineDaysLeft(c, now);
  if (daysLeft <= 0) return null;
  const list = await findCandidates({ ...c.spec, horizonDays: Math.ceil(daysLeft) });
  if (list.length === 0) return null;
  const best = list[0];
  const q = await quote(best, c.contracts * best.pricePerContract);
  return { candidate: best, premiumUsd: q.premiumUsdc };
}

export async function runWatchCycle(opts: {
  address: string;
  policy: RollPolicy;
  auto: boolean;
  now?: Date;
}): Promise<CycleReport> {
  const now = opts.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const commitments = readCommitments();
  const positions = await positionsFor(opts.address, nowSec);
  const report: CycleReport = { checked: 0, rolls: 0, blocked: 0, alerts: [] };

  for (const c of commitments) {
    // optionAddress on a Commitment is currently an order signature, not a
    // deployed contract address (execute() has no reliable on-chain option
    // address to record yet — see core.ts's writeCommitment call site). The
    // txHash comparison is the reliable match; optionAddress is kept only as
    // a best-effort fallback that may never actually match anything today.
    const p = positions.find(
      (x) => x.entryTxHash === c.txHash || x.optionAddress?.toLowerCase() === c.optionAddress.toLowerCase()
    );
    if (!p) continue;
    report.checked++;

    const decision = decideRoll(p, c, now, opts.policy);
    if (decision.action === 'none') continue;

    if (decision.action === 'blocked') {
      report.blocked++;
      const msg = `Protection on ${c.spec.asset} needs rolling but policy stopped it: ${decision.reason}`;
      report.alerts.push(msg);
      appendAudit({ at: now.toISOString(), positionId: p.id, txHash: c.txHash, decision, policy: opts.policy, note: msg });
      continue;
    }

    const replacement = await findReplacement(c, now);
    if (!replacement) {
      const msg = `Protection on ${c.spec.asset} expires in ${decision.remainingDays.toFixed(1)}d and nothing on the live book can replace it.`;
      report.alerts.push(msg);
      appendAudit({ at: now.toISOString(), positionId: p.id, txHash: c.txHash, decision, policy: opts.policy, replacement: null, note: msg });
      continue;
    }

    if (replacement.premiumUsd > opts.policy.maxPremiumUsd) {
      report.blocked++;
      const msg = `A replacement exists at $${replacement.premiumUsd.toFixed(2)} but the policy cap is $${opts.policy.maxPremiumUsd.toFixed(2)}.`;
      report.alerts.push(msg);
      appendAudit({
        at: now.toISOString(), positionId: p.id, txHash: c.txHash,
        decision: { action: 'blocked', reason: msg }, policy: opts.policy,
        replacement: { strike: replacement.candidate.strike, expiryIso: replacement.candidate.expiry.toISOString(), premiumUsd: replacement.premiumUsd },
      });
      continue;
    }

    const summary =
      `Your Payung protection on ${c.spec.asset} expires in ${decision.remainingDays.toFixed(1)} days.\n` +
      `A replacement extends your floor to ${replacement.candidate.expiry.toISOString().slice(0, 10)} ` +
      `at a $${replacement.candidate.strike.toFixed(0)} floor for $${replacement.premiumUsd.toFixed(2)}.`;

    if (!opts.auto) {
      report.alerts.push(`${summary}\n  Run: npm run execute -- ${c.spec.quantity} ${c.spec.floorTotalUsd} ${Math.ceil(decision.deadlineDaysLeft)}`);
      appendAudit({
        at: now.toISOString(), positionId: p.id, txHash: c.txHash, decision, policy: opts.policy,
        replacement: { strike: replacement.candidate.strike, expiryIso: replacement.candidate.expiry.toISOString(), premiumUsd: replacement.premiumUsd },
        note: 'notify mode — awaiting human confirmation',
      });
      continue;
    }

    // --auto: simulate first, always. Never send a fill that was not dry-run.
    await simulate(replacement.candidate, replacement.premiumUsd);

    // Mirror cli.ts's manual `execute` case: ensure the burner wallet holds
    // the order book's actual collateral token (aBasUSDC) before executing,
    // not just raw USDC. execute() sends an approval transaction before its
    // own internal resimulate/fill, so skipping this would spend gas on a
    // doomed roll whenever the wallet holds the wrong collateral shape.
    const wclient = writeClient();
    const dec = await collateralDecimals(wclient, replacement.candidate.collateralToken);
    await ensureDollarCollateral(
      wclient, replacement.candidate.collateralToken,
      BigInt(Math.round(replacement.premiumUsd * 10 ** dec))
    );

    const receipt = await execute(replacement.candidate, replacement.premiumUsd);
    incrementRolls(c.txHash);
    report.rolls++;
    report.alerts.push(`${summary}\n  Rolled. ${receipt.explorer}`);
    appendAudit({
      at: now.toISOString(), positionId: p.id, txHash: c.txHash, decision, policy: opts.policy,
      replacement: { strike: replacement.candidate.strike, expiryIso: replacement.candidate.expiry.toISOString(), premiumUsd: replacement.premiumUsd },
      simulated: true, executedTxHash: receipt.hash, note: 'auto mode — executed under policy',
    });
  }

  return report;
}
