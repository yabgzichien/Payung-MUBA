/**
 * Payung web server — a thin JSON API over src/core.ts plus static files
 * from web/. One app, two faces: the NL agent front door (Track 02) and the
 * floor-picker body (Track 01) are the same page talking to these routes.
 *
 * Candidates hold BigInts and full raw orders, so they never cross the wire:
 * the server caches them by id and the browser only ever sees flat numbers.
 */
import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import {
  findCandidates, quote, simulate, execute, payoffCurve, coverageGapDays,
  collateralDecimals, writeClient, type Candidate, type ProtectionSpec,
} from './core.js';
import { parseIntent, gonkaLlm, validateSpec } from './intent.js';
import { judgeQuote } from './judgment.js';
import { ensureDollarCollateral } from './aave.js';

const PORT = Number(process.env.PORT ?? 8787);
const WEB_ROOT = join(process.cwd(), 'web');

/** Candidates from the latest search, by id. One user, one demo — a Map is the right size. */
const cache = new Map<string, { candidate: Candidate; spec: ProtectionSpec }>();

/**
 * Marks an error as caused by bad client input (a malformed spec, a stale
 * candidate id) rather than a genuine server/RPC failure. The top-level
 * route(...).catch() below checks for this to pick 400 vs 500 — without it,
 * every thrown error looked like a 500, and a caller couldn't tell "fix your
 * request" from "the server broke" by status code alone.
 */
class ClientError extends Error {}

export function candidateId(c: Candidate): string {
  return `${String(c.raw?.signature ?? '0x').slice(2, 18)}-${Math.round(c.strike)}`;
}

export function toWire(c: Candidate, spec: ProtectionSpec) {
  return {
    id: candidateId(c),
    strike: c.strike,
    expiryIso: c.expiry.toISOString(),
    daysToExpiry: c.daysToExpiry,
    pricePerContract: c.pricePerContract,
    iv: c.greeks.iv ?? null,
    coverageGapDays: coverageGapDays(c, spec),
    makerBudget: c.makerBudget,
  };
}

export function jsonSafe(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(jsonSafe(body));
}

function getCached(id: string) {
  const entry = cache.get(id);
  if (!entry) throw new ClientError('Unknown or stale candidate id — search again.');
  return entry;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

async function serveStatic(url: string, res: ServerResponse) {
  const path = url === '/' ? '/index.html' : url;
  const file = normalize(join(WEB_ROOT, path));
  if (!file.startsWith(WEB_ROOT)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = (req.url ?? '/').split('?')[0];

  if (req.method === 'POST' && url === '/api/parse') {
    const { text } = await readBody(req);
    if (!text) return send(res, 400, { error: 'Missing "text"' });
    const spec = await parseIntent(String(text), gonkaLlm());
    return send(res, 200, { spec });
  }

  if (req.method === 'POST' && url === '/api/candidates') {
    const body = await readBody(req);
    let spec: ProtectionSpec;
    try {
      spec = validateSpec(body.spec);
    } catch (e: any) {
      // validateSpec's own throws are about a malformed client-supplied spec,
      // never a server/RPC problem — re-tag so the caller gets 400, not 500.
      throw new ClientError(e?.message ?? String(e));
    }
    const candidates = await findCandidates(spec);
    cache.clear();
    for (const c of candidates) cache.set(candidateId(c), { candidate: c, spec });
    return send(res, 200, { candidates: candidates.map((c) => toWire(c, spec)) });
  }

  if (req.method === 'POST' && url === '/api/quote') {
    const { id, spendUsdc } = await readBody(req);
    const { candidate, spec } = getCached(String(id));
    const q = await quote(candidate, Number(spendUsdc) || 10);
    const gap = coverageGapDays(candidate, spec);
    return send(res, 200, {
      quote: {
        strike: q.strike, expiryIso: q.expiry.toISOString(),
        requestedUsdc: q.requestedUsdc, spendUsdc: q.spendUsdc, capped: q.capped,
        premiumUsdc: q.premiumUsdc, pricePerContract: q.pricePerContract, yourSide: q.yourSide,
      },
      judgment: judgeQuote(q, gap),
      payoff: payoffCurve(q, [q.strike * 0.8, q.strike * 1.2], 40),
    });
  }

  if (req.method === 'POST' && url === '/api/simulate') {
    const { id, spendUsdc } = await readBody(req);
    const { candidate } = getCached(String(id));
    // Re-derive the capped spend the same way the CLI does: quote first, then
    // simulate the amount that will actually be sent, never the raw request.
    const q = await quote(candidate, Number(spendUsdc) || 10);
    const sim = await simulate(candidate, q.spendUsdc);
    return send(res, 200, { ok: sim.ok, error: sim.error });
  }

  if (req.method === 'POST' && url === '/api/execute') {
    const { id, spendUsdc, confirm } = await readBody(req);
    if (confirm !== true) return send(res, 400, { error: 'Set confirm:true — this spends real USDC on Base mainnet.' });
    const { candidate } = getCached(String(id));
    const client = writeClient();
    // Same sequencing as the CLI's shared quote/simulate/execute case: quote
    // to get the maker-capped spend, ensure collateral for THAT amount, then
    // execute with it — never the raw requested number.
    const q = await quote(candidate, Number(spendUsdc) || 10, client);
    const dec = await collateralDecimals(client, candidate.collateralToken);
    await ensureDollarCollateral(client, candidate.collateralToken, BigInt(Math.round(q.spendUsdc * 10 ** dec)));
    const result = await execute(candidate, q.spendUsdc, client);
    return send(res, 200, { hash: result.hash, explorer: result.explorer, paidUsd: result.paidUsd });
  }

  if (req.method === 'GET') return serveStatic(url, res);
  return send(res, 404, { error: 'not found' });
}

// Only start listening when run directly (so tests can import the pure helpers).
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  createServer((req, res) => {
    route(req, res).catch((e: any) =>
      send(res, e instanceof ClientError ? 400 : 500, { error: e?.shortMessage || e?.message || String(e) })
    );
  }).listen(PORT, () => {
    console.log(`Payung running at http://localhost:${PORT} — BASE MAINNET, real orders.`);
  });
}
