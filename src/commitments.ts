/**
 * What the user actually asked for, recorded locally against the trade.
 *
 * The chain knows the option; it does not know the DEADLINE the user stated,
 * and that deadline is the whole reason an expiring position is a problem.
 * `horizonDays` is resolved to an absolute date at write time — a relative
 * horizon is meaningless to a process that wakes up days later.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProtectionSpec } from './spec';

export type Commitment = {
  txHash: string;
  optionAddress: string;
  spec: ProtectionSpec;
  deadlineIso: string;
  strike: number;
  expiryIso: string;
  contracts: number;
  rollsUsed: number;
  createdAt: string;
};

const DAY_MS = 86_400_000;
export const DEFAULT_DIR = '.payung';
const FILE = 'commitments.json';

export function commitmentFor(
  spec: ProtectionSpec, txHash: string, optionAddress: string,
  strike: number, expiryIso: string, contracts: number, now: Date
): Commitment {
  return {
    txHash, optionAddress, spec, strike, expiryIso, contracts,
    deadlineIso: new Date(now.getTime() + spec.horizonDays * DAY_MS).toISOString(),
    rollsUsed: 0,
    createdAt: now.toISOString(),
  };
}

export function deadlineDaysLeft(c: Commitment, now: Date): number {
  return (new Date(c.deadlineIso).getTime() - now.getTime()) / DAY_MS;
}

export function readCommitments(dir = DEFAULT_DIR): Commitment[] {
  const path = join(dir, FILE);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

export function writeCommitment(c: Commitment, dir = DEFAULT_DIR): void {
  mkdirSync(dir, { recursive: true });
  const all = readCommitments(dir).filter((x) => x.txHash !== c.txHash);
  writeFileSync(join(dir, FILE), JSON.stringify([...all, c], null, 2));
}

/** Advance the counter decideRoll checks against maxRolls. No-op if unknown. */
export function incrementRolls(txHash: string, dir = DEFAULT_DIR): void {
  const all = readCommitments(dir);
  const found = all.find((c) => c.txHash === txHash);
  if (!found) return;
  found.rollsUsed += 1;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE), JSON.stringify(all, null, 2));
}
