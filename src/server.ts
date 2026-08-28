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
import { ethers } from 'ethers';
import {
  findCandidates, quote, simulate, execute, payoffCurve, coverageGapDays,
  collateralDecimals, writeClient, readClient, assertFillable, USDC_DECIMALS,
  impliedStrike, type Candidate, type ProtectionSpec,
} from './core.js';
import { parseIntent, gonkaLlm, validateSpec } from './intent.js';
import { judgeQuote } from './judgment.js';
import { ensureDollarCollateral } from './aave.js';

const PORT = Number(process.env.PORT ?? 8787);
const WEB_ROOT = join(process.cwd(), 'web');

/** Candidates from the latest search, by id. One user, one demo — a Map is the right size. */
const cache = new Map<string, { candidate: Candidate; spec: ProtectionSpec; fetchedAt: number }>();

/** A candidate older than this is refused rather than quoted/filled against — the live book moves. */
const CACHE_MAX_AGE_MS = 3 * 60 * 1000;

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
  const target = impliedStrike(spec);
  const pctVs = ((target - c.strike) / target) * 100;
  return {
    id: candidateId(c),
    strike: c.strike,
    expiryIso: c.expiry.toISOString(),
    daysToExpiry: c.daysToExpiry,
    pricePerContract: c.pricePerContract,
    iv: c.greeks.iv ?? null,
    coverageGapDays: coverageGapDays(c, spec),
    makerBudget: c.makerBudget,
    /** The per-unit strike the user's stated quantity + total floor implies — what this candidate is being ranked against. */
    impliedStrike: target,
    /** Signed: positive = this strike is BELOW the user's floor (weaker protection); negative = above it (stronger, but pricier). For display. */
    pctVsImpliedStrike: pctVs,
    /**
     * Absolute distance from the user's implied strike. This — not the signed
     * value — gates the "closest match" badge. filterCandidates ranks by
     * absolute distance, so when the book's nearest strikes all sit ABOVE the
     * requested floor, list[0] can be far above it; clamping negatives to 0
     * would badge that as a perfect match and suppress the far-miss warning.
     */
    pctFromImpliedStrike: Math.abs(pctVs),
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
  if (Date.now() - entry.fetchedAt > CACHE_MAX_AGE_MS) {
    cache.delete(id);
    throw new ClientError('This candidate was fetched too long ago — the book may have moved. Search again.');
  }
  return entry;
}

/** Validates a client-supplied spend amount. Missing/undefined defaults to 10; anything present must be sane. */
function parseSpend(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 10;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ClientError(`spendUsdc must be a positive finite number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

async function serveStatic(url: string, res: ServerResponse) {
  if (url === '/ethers.min.js' || url === '/ethers.js') {
    const ethersFile = join(process.cwd(), 'node_modules/ethers/dist/ethers.umd.min.js');
    try {
      const data = await readFile(ethersFile);
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(data);
    } catch {
      return send(res, 404, { error: 'ethers bundle not found' });
    }
  }

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

  if (req.method === 'POST') {
    // Cross-site POSTs from another page's <form>/fetch never carry
    // "application/json" without triggering a CORS preflight — and this
    // server sends no Access-Control-Allow-* headers, so the browser blocks
    // the response before the attacker page can read it. Requiring this
    // header turns a same-origin-only "simple request" (no preflight, would
    // otherwise sail through) into a request the browser refuses to send
    // cross-site at all. Every route here can trigger a real spend
    // (/api/execute) or seed state another route trusts (/api/candidates) —
    // this must be checked before any route body runs.
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return send(res, 400, { error: 'Content-Type must be application/json' });
    }
  }

  if (req.method === 'POST' && url === '/api/parse') {
    const { text } = await readBody(req);
    if (!text) return send(res, 400, { error: 'Missing "text"' });
    try {
      const spec = await parseIntent(String(text), gonkaLlm());
      return send(res, 200, { spec });
    } catch (e: any) {
      // Almost always "the LLM's output didn't validate against the strict
      // {asset, floorUsd, horizonDays} schema" — a property of what the user
      // typed, not a server fault. Re-tag so the caller gets 400, not 500.
      throw new ClientError(e?.message ?? String(e));
    }
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
    for (const c of candidates) cache.set(candidateId(c), { candidate: c, spec, fetchedAt: Date.now() });
    return send(res, 200, { candidates: candidates.map((c) => toWire(c, spec)) });
  }

  if (req.method === 'POST' && url === '/api/quote') {
    const { id, spendUsdc } = await readBody(req);
    const { candidate, spec } = getCached(String(id));
    const q = await quote(candidate, parseSpend(spendUsdc));
    const gap = coverageGapDays(candidate, spec);
    return send(res, 200, {
      quote: {
        strike: q.strike, expiryIso: q.expiry.toISOString(),
        requestedUsdc: q.requestedUsdc, spendUsdc: q.spendUsdc, capped: q.capped,
        premiumUsdc: q.premiumUsdc, pricePerContract: q.pricePerContract, yourSide: q.yourSide,
        contracts: q.contracts,
      },
      judgment: judgeQuote(q, gap),
      payoff: payoffCurve(q, [q.strike * 0.8, q.strike * 1.2], 40),
    });
  }

  if (req.method === 'POST' && url === '/api/simulate') {
    const { id, spendUsdc } = await readBody(req);
    const { candidate } = getCached(String(id));
    const q = await quote(candidate, parseSpend(spendUsdc));
    try {
      assertFillable(candidate, Math.floor(Date.now() / 1000));
      if (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY !== '0x') {
        const sim = await simulate(candidate, q.spendUsdc);
        return send(res, 200, { ok: sim.ok, error: sim.error });
      }
      return send(res, 200, { ok: true });
    } catch (e: any) {
      return send(res, 200, { ok: false, error: e?.message || String(e) });
    }
  }

  if (req.method === 'POST' && url === '/api/prepare-tx') {
    const { id, spendUsdc, takerAddress } = await readBody(req);
    const { candidate } = getCached(String(id));
    const client = readClient();
    const q = await quote(candidate, parseSpend(spendUsdc), client);
    const dec = await collateralDecimals(client, candidate.collateralToken);
    if (dec !== USDC_DECIMALS) {
      throw new ClientError(`${candidate.collateralToken} has ${dec} decimals, not the assumed ${USDC_DECIMALS} — refusing to guess the scale.`);
    }
    const collateralUnits = BigInt(Math.round(q.spendUsdc * 10 ** dec));
    const usdcUnits = BigInt(Math.round(q.spendUsdc * 10 ** USDC_DECIMALS));

    assertFillable(candidate, Math.floor(Date.now() / 1000));

    const optionBookAddress = client.getContractAddress('optionBook');
    const fillTx = client.optionBook.encodeFillOrder(candidate.raw, usdcUnits);
    const approveOptionBookTx = client.erc20.encodeApprove(
      candidate.collateralToken,
      optionBookAddress,
      collateralUnits
    );

    const isAaveToken = candidate.collateralToken.toLowerCase() === '0x4e65fe4dba92790696d040ac24aa414708f5c0ab'.toLowerCase();
    const rawUsdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const aavePoolAddress = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

    let aavePlan = null;
    if (isAaveToken) {
      const aaveIface = new ethers.Interface([
        'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)'
      ]);
      const aaveSupplyData = aaveIface.encodeFunctionData('supply', [
        rawUsdcAddress,
        collateralUnits,
        takerAddress || ethers.ZeroAddress,
        0,
      ]);
      const approveAaveTx = client.erc20.encodeApprove(
        rawUsdcAddress,
        aavePoolAddress,
        collateralUnits
      );
      aavePlan = {
        isAaveToken: true,
        aBasUsdcAddress: candidate.collateralToken,
        rawUsdcAddress,
        aavePoolAddress,
        supplyAmount: collateralUnits.toString(),
        approveAaveTx,
        supplyTx: {
          to: aavePoolAddress,
          data: aaveSupplyData,
        },
      };
    }

    return send(res, 200, {
      quote: {
        requestedUsdc: q.requestedUsdc,
        spendUsdc: q.spendUsdc,
        capped: q.capped,
        premiumUsdc: q.premiumUsdc,
        strike: q.strike,
        expiryIso: q.expiry.toISOString(),
        yourSide: q.yourSide,
      },
      collateralToken: candidate.collateralToken,
      collateralDecimals: dec,
      collateralUnits: collateralUnits.toString(),
      optionBookAddress,
      approveOptionBookTx,
      fillTx,
      aavePlan,
    });
  }

  if (req.method === 'POST' && url === '/api/execute') {
    const { id, spendUsdc, confirm } = await readBody(req);
    if (confirm !== true) return send(res, 400, { error: 'Set confirm:true — this spends real USDC on Base mainnet.' });
    const { candidate } = getCached(String(id));
    const client = writeClient();
    // Check fillability BEFORE spending anything — including the Aave deposit
    // below, which is itself a real transaction. Checking only inside
    // execute() (after the deposit) means a stale/unfillable order costs a
    // real deposit tx before the fill is ever refused.
    assertFillable(candidate, Math.floor(Date.now() / 1000));
    // Same sequencing as the CLI's shared quote/simulate/execute case: quote
    // to get the maker-capped spend, ensure collateral for THAT amount, then
    // execute with it — never the raw requested number.
    const q = await quote(candidate, parseSpend(spendUsdc), client);
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
  }).listen(PORT, '127.0.0.1', () => {
    console.log(`Payung running at http://localhost:${PORT} — BASE MAINNET, real orders.`);
  });
}
