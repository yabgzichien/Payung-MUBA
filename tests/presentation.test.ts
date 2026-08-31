import { describe, it, expect } from 'vitest';
import { badgeFor } from '../src/presentation.js';
import { makeCandidate } from './fixtures.js';

const spec = { asset: 'ETH' as const, quantity: 1, floorTotalUsd: 2300, horizonDays: 14 };

describe('badgeFor', () => {
  it('badges an exact floor that covers the horizon as good', () => {
    const b = badgeFor(makeCandidate({ strike: 2300, daysToExpiry: 16 }), spec, true);
    expect(b.state).toBe('surplus');
    expect(b.tone).toBe('good');
    expect(b.text).toContain('FULL COVER');
  });

  it('never emits a good tone for a short-dated candidate', () => {
    const b = badgeFor(makeCandidate({ strike: 2300, daysToExpiry: 11.9 }), spec, true);
    expect(b.tone).toBe('warn');
    expect(b.state).toBe('short');
    expect(b.text).toContain('2.1 DAYS SHORT');
  });

  it('never emits the retired EXACT MATCH text', () => {
    const b = badgeFor(makeCandidate({ strike: 2300, daysToExpiry: 11.9 }), spec, true);
    expect(b.text).not.toContain('EXACT MATCH');
  });

  it('reports coverage before strike proximity when both are wrong', () => {
    // 8.4d short AND 8.7% off the floor — coverage is the headline defect.
    const b = badgeFor(makeCandidate({ strike: 2100, daysToExpiry: 9 }), spec, true);
    expect(b.state).toBe('short');
  });

  it('flags a far strike that does cover the horizon', () => {
    const b = badgeFor(makeCandidate({ strike: 2100, daysToExpiry: 16 }), spec, true);
    expect(b.state).toBe('far-from-floor');
    expect(b.tone).toBe('warn');
  });

  it('labels a non-top pick as the user’s own choice', () => {
    const b = badgeFor(makeCandidate({ strike: 2290, daysToExpiry: 16 }), spec, false);
    expect(b.text).toContain('YOUR PICK');
    expect(b.tone).toBe('neutral');
  });

  it('says FULL COVER with no surplus when expiry lands on the deadline', () => {
    const b = badgeFor(makeCandidate({ strike: 2300, daysToExpiry: 14 }), spec, true);
    expect(b.state).toBe('full');
    expect(b.tone).toBe('good');
  });
});
