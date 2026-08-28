import { describe, it, expect } from 'vitest';
import { toCandles, granularityFor } from '../src/spot.js';

describe('toCandles', () => {
  it('normalizes Coinbase [time, low, high, open, close, volume] rows into {t,o,h,l,c}', () => {
    const raw = [
      [1700000000, 2400, 2450, 2420, 2440, 1234.5],
      [1700000060, 2440, 2460, 2440, 2455, 987.6],
    ];
    expect(toCandles(raw)).toEqual([
      { t: 1700000000, o: 2420, h: 2450, l: 2400, c: 2440 },
      { t: 1700000060, o: 2440, h: 2460, l: 2440, c: 2455 },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(toCandles([])).toEqual([]);
  });

  it('drops malformed rows (wrong length) instead of throwing', () => {
    const raw = [
      [1700000000, 2400, 2450, 2420, 2440, 1234.5],
      [1700000060, 2440], // malformed
    ];
    expect(toCandles(raw)).toHaveLength(1);
  });
});

describe('granularityFor', () => {
  // The horizon field allows 1-90 days, and the /api/history route clamps to
  // that same range, so every value in it must stay under Coinbase's cap.
  it('keeps every day-count in the allowed 1-90 range under 300 candles', () => {
    for (let days = 1; days <= 90; days++) {
      const g = granularityFor(days);
      expect((days * 86400) / g).toBeLessThanOrEqual(300);
    }
  });

  it('only ever returns a granularity Coinbase accepts', () => {
    const allowed = [60, 300, 900, 3600, 21600, 86400];
    for (let days = 1; days <= 90; days++) {
      expect(allowed).toContain(granularityFor(days));
    }
  });

  // Regression guards for the two values a fixed if/else ladder got wrong.
  it('does not return 5m candles for a 2-day window (576 candles = HTTP 400)', () => {
    expect(granularityFor(2)).toBeGreaterThan(300);
  });

  it('does not return 6h candles for a 90-day window (360 candles = HTTP 400)', () => {
    expect(granularityFor(90)).toBeGreaterThan(21600);
  });
});
