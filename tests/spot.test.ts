import { describe, it, expect } from 'vitest';
import { toCandles } from '../src/spot.js';

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
