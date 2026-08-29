import { describe, it, expect } from 'vitest';
import { parseIntent, validateSpec, parsePartialIntent, classifyPartialSpec } from '../src/intent.js';

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

describe('classifyPartialSpec', () => {
  it('fills every field with no missing/errors when the sentence states a total value', () => {
    const result = classifyPartialSpec({ asset: 'ETH', quantity: 1, floorValue: 2300, floorMode: 'total', horizonDays: 14 });
    expect(result).toEqual({
      asset: 'ETH', quantity: 1, unitFloorUsd: 2300, floorTotalUsd: 2300, horizonDays: 14,
      missingFields: [], fieldErrors: {},
    });
  });

  it('computes floorTotalUsd in code (not the model) from a per-unit market price', () => {
    const result = classifyPartialSpec({ asset: 'BTC', quantity: 0.4, floorValue: 62000, floorMode: 'perUnit', horizonDays: 30 });
    expect(result.unitFloorUsd).toBe(62000);
    expect(result.floorTotalUsd).toBeCloseTo(24800, 6);
    expect(result.missingFields).toEqual([]);
    expect(result.fieldErrors).toEqual({});
  });

  it('flags a single omitted field as missing without discarding the rest', () => {
    const result = classifyPartialSpec({ asset: 'ETH', quantity: 1, floorValue: 2300, floorMode: 'total', horizonDays: null });
    expect(result.horizonDays).toBeNull();
    expect(result.missingFields).toEqual(['horizonDays']);
    expect(result.fieldErrors).toEqual({});
    expect(result.asset).toBe('ETH');
    expect(result.floorTotalUsd).toBe(2300);
  });

  it('flags all four as missing when nothing was stated', () => {
    const result = classifyPartialSpec({ asset: null, quantity: null, floorValue: null, floorMode: null, horizonDays: null });
    expect(result.missingFields.sort()).toEqual(['asset', 'floor', 'horizonDays', 'quantity']);
    expect(result.fieldErrors).toEqual({});
  });

  it('flags an unsupported asset as a field error, leaving the other fields filled', () => {
    const result = classifyPartialSpec({ asset: 'SOL', quantity: 1, floorValue: 2300, floorMode: 'total', horizonDays: 14 });
    expect(result.asset).toBeNull();
    expect(result.fieldErrors.asset).toMatch(/Unsupported asset/);
    expect(result.missingFields).toEqual([]);
    expect(result.quantity).toBe(1);
    expect(result.floorTotalUsd).toBe(2300);
    expect(result.horizonDays).toBe(14);
  });

  it('flags a non-positive quantity as a field error instead of throwing', () => {
    const result = classifyPartialSpec({ asset: 'ETH', quantity: 0, floorValue: 2300, floorMode: 'total', horizonDays: 14 });
    expect(result.quantity).toBeNull();
    expect(result.fieldErrors.quantity).toMatch(/positive/i);
  });

  it('flags an out-of-range horizon as a field error instead of throwing', () => {
    const result = classifyPartialSpec({ asset: 'ETH', quantity: 1, floorValue: 2300, floorMode: 'total', horizonDays: 400 });
    expect(result.horizonDays).toBeNull();
    expect(result.fieldErrors.horizonDays).toMatch(/1-90/);
  });

  it('flags an implausible implied strike as a floor field error (the $798-for-1000-ETH regression class)', () => {
    const result = classifyPartialSpec({ asset: 'ETH', quantity: 1000, floorValue: 798, floorMode: 'total', horizonDays: 7 });
    expect(result.fieldErrors.floor).toMatch(/implied|strike/i);
    expect(result.unitFloorUsd).toBeNull();
    expect(result.floorTotalUsd).toBeNull();
  });

  it('derives the per-unit floor from a stated total once quantity is known', () => {
    const result = classifyPartialSpec({ asset: 'ETH', quantity: 2, floorValue: 4600, floorMode: 'total', horizonDays: 14 });
    expect(result.unitFloorUsd).toBe(2300);
    expect(result.floorTotalUsd).toBe(4600);
  });

  it('keeps a stated per-unit price but leaves the total null when quantity is missing', () => {
    const result = classifyPartialSpec({ asset: 'BTC', quantity: null, floorValue: 62000, floorMode: 'perUnit', horizonDays: 30 });
    expect(result.unitFloorUsd).toBe(62000);
    expect(result.floorTotalUsd).toBeNull();
    expect(result.missingFields).toEqual(['quantity']);
    expect(result.fieldErrors).toEqual({});
  });

  it('flags the floor as a field error when a value is given without a recognizable perUnit/total mode', () => {
    const result = classifyPartialSpec({ asset: 'ETH', quantity: 1, floorValue: 2300, floorMode: null, horizonDays: 14 });
    expect(result.unitFloorUsd).toBeNull();
    expect(result.floorTotalUsd).toBeNull();
    expect(result.fieldErrors.floor).toMatch(/per-unit|total/i);
    expect(result.missingFields).not.toContain('floor');
  });
});

describe('parsePartialIntent', () => {
  it('still throws for a non-protection request via the error field', async () => {
    await expect(parsePartialIntent('x', llmReturning('{"error":"asked for a joke"}'))).rejects.toThrow(/Not a protection request/);
  });

  it('still throws when the model returns no JSON', async () => {
    await expect(parsePartialIntent('x', llmReturning('I cannot help with that'))).rejects.toThrow(/no JSON/);
  });

  it('parses a fully-specified sentence end to end', async () => {
    const result = await parsePartialIntent(
      'x',
      llmReturning('{"asset":"BTC","quantity":0.4,"floorValue":62000,"floorMode":"perUnit","horizonDays":30}'),
    );
    expect(result).toEqual({
      asset: 'BTC', quantity: 0.4, unitFloorUsd: 62000, floorTotalUsd: 24800, horizonDays: 30,
      missingFields: [], fieldErrors: {},
    });
  });

  it('parses a partially-specified sentence without throwing', async () => {
    const result = await parsePartialIntent('x', llmReturning('{"asset":"ETH","quantity":null,"floorValue":null,"floorMode":null,"horizonDays":14}'));
    expect(result.asset).toBe('ETH');
    expect(result.horizonDays).toBe(14);
    expect(result.missingFields.sort()).toEqual(['floor', 'quantity']);
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
