import { describe, it, expect } from 'vitest';
import { parseIntent, validateSpec } from '../src/intent.js';

const llmReturning = (s: string) => async () => s;

describe('parseIntent', () => {
  it('accepts clean JSON', async () => {
    const spec = await parseIntent('x', llmReturning('{"asset":"ETH","floorUsd":2300,"horizonDays":14}'));
    expect(spec).toEqual({ asset: 'ETH', floorUsd: 2300, horizonDays: 14 });
  });

  it('extracts JSON wrapped in prose', async () => {
    const spec = await parseIntent('x', llmReturning('Sure! {"asset":"BTC","floorUsd":60000,"horizonDays":30} there.'));
    expect(spec.asset).toBe('BTC');
  });

  it('rejects a non-protection request via the error field', async () => {
    await expect(parseIntent('x', llmReturning('{"error":"asked for a joke"}'))).rejects.toThrow(/Not a protection request/);
  });

  it('rejects unsupported assets', async () => {
    await expect(parseIntent('x', llmReturning('{"asset":"DOGE","floorUsd":1,"horizonDays":7}'))).rejects.toThrow(/Unsupported asset/);
  });

  it('rejects out-of-range horizons and floors', async () => {
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","floorUsd":2300,"horizonDays":400}'))).rejects.toThrow(/1-90/);
    await expect(parseIntent('x', llmReturning('{"asset":"ETH","floorUsd":-5,"horizonDays":7}'))).rejects.toThrow(/floor/i);
  });

  it('rejects non-JSON garbage', async () => {
    await expect(parseIntent('x', llmReturning('I cannot help with that'))).rejects.toThrow(/no JSON/);
  });
});

describe('validateSpec', () => {
  it('round-trips a valid spec object', () => {
    expect(validateSpec({ asset: 'ETH', floorUsd: 2300, horizonDays: 14 })).toEqual({
      asset: 'ETH', floorUsd: 2300, horizonDays: 14,
    });
  });
});
