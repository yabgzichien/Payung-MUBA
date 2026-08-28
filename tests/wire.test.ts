import { describe, it, expect } from 'vitest';
import { candidateId, toWire, jsonSafe } from '../src/server.js';
import { makeCandidate } from './fixtures.js';

const spec = { asset: 'ETH' as const, floorUsd: 2300, horizonDays: 14 };

describe('wire format', () => {
  it('candidateId is stable and derived from the order signature + strike', () => {
    const c = makeCandidate({ raw: { signature: '0xdeadbeefdeadbeefdeadbeef' } });
    expect(candidateId(c)).toBe(candidateId(c));
    expect(candidateId(c)).toContain('2300');
  });

  it('toWire carries no raw order and no bigints', () => {
    const w = toWire(makeCandidate({ daysToExpiry: 8.7 }), spec);
    expect((w as any).raw).toBeUndefined();
    expect(w.coverageGapDays).toBeCloseTo(5.3);
    expect(() => JSON.stringify(w)).not.toThrow();
  });

  it('jsonSafe serializes bigints as strings', () => {
    expect(jsonSafe({ a: 5n })).toBe('{"a":"5"}');
  });
});
