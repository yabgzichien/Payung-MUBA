/**
 * In-memory control surface for the watcher's background loop, driven by the
 * GUI (app/api/watcher/*). Lives inside the same long-lived `npm run web`
 * process — see watcherLoopAllowed() in api-shared.ts for why this cannot
 * exist on a serverless deployment. Module-scoped state, same pattern as the
 * caches already in api-shared.ts: one server, one operator, an in-memory
 * singleton is the right size.
 */
import { runWatchCycle, type CycleReport } from './watcher';
import { validatePolicy, type RollPolicy } from './policy';
import { signerFromEnv, readClient } from './core';

const INTERVAL_MS = 60_000;

/** withErrorHandling (api-shared.ts) reads `.status` off any thrown error to pick the HTTP status. */
function statusError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

let running = false;
let auto = false;
let policy: RollPolicy | null = null;
let lastCycleAt: string | null = null;
let lastReport: CycleReport | null = null;
let error: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let cycleInFlight = false;

export type WatcherState = {
  running: boolean;
  auto: boolean;
  policy: RollPolicy | null;
  lastCycleAt: string | null;
  lastReport: CycleReport | null;
  error: string | null;
};

export function getState(): WatcherState {
  return { running, auto, policy, lastCycleAt, lastReport, error };
}

/** The one wallet the watcher ever acts on. Throws if PRIVATE_KEY is missing/invalid — callers catch and surface. */
export function getSignerAddress(): string {
  return signerFromEnv(readClient().provider).address;
}

/**
 * Runs exactly one cycle with the given settings, independent of whether the
 * loop is started — this is what both "Check now" and the interval tick call,
 * so they share the same cycleInFlight guard and can never race each other
 * into two concurrent runWatchCycle calls against the same commitments.
 */
export async function runOnce(opts: { auto: boolean; policy: RollPolicy }): Promise<CycleReport> {
  const errs = validatePolicy(opts.policy);
  if (errs.length) throw statusError(400, errs.join('; '));
  if (cycleInFlight) throw statusError(409, 'A cycle is already running — try again in a moment.');

  cycleInFlight = true;
  try {
    const address = getSignerAddress();
    const report = await runWatchCycle({ address, policy: opts.policy, auto: opts.auto });
    lastReport = report;
    lastCycleAt = new Date().toISOString();
    error = null;
    return report;
  } catch (e: any) {
    error = e?.shortMessage || e?.message || String(e);
    throw e;
  } finally {
    cycleInFlight = false;
  }
}

async function tick(): Promise<void> {
  if (!policy) return;
  try {
    await runOnce({ auto, policy });
  } catch {
    // Already recorded in `error` by runOnce — the interval keeps going;
    // a single bad cycle (e.g. a flaky RPC call) must not kill the loop.
  }
}

/** Starts the interval. Returns validation errors instead of starting, same shape as the CLI's --auto refusal. */
export function start(opts: { auto: boolean; policy: RollPolicy }): string[] {
  const errs = validatePolicy(opts.policy);
  if (errs.length) return errs;

  if (timer) clearInterval(timer);
  auto = opts.auto;
  policy = opts.policy;
  running = true;
  error = null;
  timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  void tick(); // first cycle immediately — don't make the operator wait 60s to see it's working
  return [];
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
