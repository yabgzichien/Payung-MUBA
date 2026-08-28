import { describe, it, expect } from 'vitest';
import { parseIntent, validateSpec } from '../src/intent.js';

const llmReturning = (s: string) => async () => s;

describe('parseIntent', () => {
  it('accepts clean JSON', async () => {
    const spec = await parseIntent('x', llmReturning('{"asset":"ETH","quantity":1,"floorTotalUsd":2300,"horizonDays":14}'));
    expect(spec).toEqual({ asset: 'ETH', quantity: 1, floorTotalUsd: 2300, horizonDays: 14 });
  });

  it('extracts JSON wrapped in prose', async () => {
    const spec = await parseIntent('x', llmReturning('Sure! {"asset":"BTC","quantity":1,"floorTotalUsd":60000,"horizonDays":30} there.'));
    expect(spec.asset).toBe('BTC');
  });

  it('rejects a non-protection request via the error field', async () => {
    await expect(parseIntent('x', llmReturning('{"error":"asked for a joke"}'))).rejects.toThrow(/Not a protection request/);
  });

  it('rejects unsupported assets', async () => {
    await expect(parseIntent('x', llmReturning('{"asset":"DOGE","quantity":1,"floorTotalUsd":1,"horizonDays":7}'))).rejects.toThrow(/Unsupported asset/);
  });

  it('rejects out-of-range horizons', async () => {
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","quantity":1,"floorTotalUsd":2300,"horizonDays":400}'))).rejects.toThrow(/1-90/);
  });

  it('rejects a missing or non-positive quantity', async () => {
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","floorTotalUsd":2300,"horizonDays":7}'))).rejects.toThrow(/quantity/i);
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","quantity":0,"floorTotalUsd":2300,"horizonDays":7}'))).rejects.toThrow(/quantity/i);
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","quantity":-1,"floorTotalUsd":2300,"horizonDays":7}'))).rejects.toThrow(/quantity/i);
  });

  it('rejects an implied strike outside the plausible range (the $798-for-0.32-ETH regression class)', async () => {
    // 1000 ETH at a $798 total floor implies a $0.80/ETH strike — implausible.
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","quantity":1000,"floorTotalUsd":798,"horizonDays":7}'))).rejects.toThrow(/implied|strike/i);
  });

  it('rejects non-JSON garbage', async () => {
    await expect(parseIntent('x', llmReturning('I cannot help with that'))).rejects.toThrow(/no JSON/);
  });

  // Regression: greedy `/\{[\s\S]*\}/` used to span from the first `{` to the
  // LAST `}` in the whole response. A nested answer like `{"result": {...}}`
  // is itself a single balanced top-level object, so it parses successfully
  // either way — but the real fields live one level down, leaving
  // asset/quantity/floorTotalUsd/horizonDays undefined at the top. That used
  // to surface as a misleading "Unsupported asset: undefined", which looks
  // like an asset validation failure rather than a shape problem. It must
  // now be reported as a clear, correctly-attributed shape error instead.
  it('rejects a nested answer object with a shape error, not a misleading asset error', async () => {
    const promise = parseIntent(
      'x',
      llmReturning('{"result":{"asset":"ETH","quantity":1,"floorTotalUsd":2300,"horizonDays":14}}'),
    );
    await expect(promise).rejects.toThrow(/shape/i);
    await expect(promise).rejects.not.toThrow(/Unsupported asset/);
  });

  // Regression: if the model echoes a format example before its real answer,
  // the old greedy regex spanned BOTH `{...}` objects plus the prose between
  // them, so `JSON.parse` threw and the user saw "invalid JSON" for what was
  // actually a usable answer sitting later in the string. The balanced-brace
  // scanner instead grabs the first complete object it finds (here, the
  // format example) — which is itself an inherent ambiguity in extracting
  // from unstructured prose, not something a smarter scanner fully resolves.
  // What matters is that the outcome fails closed with a clear, attributable
  // error (not a crash, and not the old "invalid JSON" message) rather than
  // silently fabricating or misreporting a number.
  it('fails closed (not a JSON-parse crash) when a format example precedes the real answer', async () => {
    const promise = parseIntent(
      'x',
      llmReturning('Format: {"asset":"ETH"} Answer: {"asset":"BTC","quantity":1,"floorTotalUsd":60000,"horizonDays":30}'),
    );
    await expect(promise).rejects.toThrow(/quantity/i);
    await expect(promise).rejects.not.toThrow(/invalid JSON/);
  });
});

describe('validateSpec', () => {
  it('round-trips a valid spec object', () => {
    expect(validateSpec({ asset: 'ETH', quantity: 1, floorTotalUsd: 2300, horizonDays: 14 })).toEqual({
      asset: 'ETH', quantity: 1, floorTotalUsd: 2300, horizonDays: 14,
    });
  });

  it('accepts a fractional quantity with a sane implied strike (the $798-for-0.32-ETH case, corrected)', () => {
    const spec = validateSpec({ asset: 'ETH', quantity: 0.32, floorTotalUsd: 798, horizonDays: 14 });
    expect(spec.quantity).toBe(0.32);
    expect(spec.floorTotalUsd).toBe(798);
  });
});
