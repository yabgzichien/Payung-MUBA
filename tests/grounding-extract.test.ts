import { describe, it, expect } from 'vitest';
import { extractNumbers } from '../src/grounding.js';

const values = (t: string) => extractNumbers(t).map((n) => n.value);

describe('extractNumbers', () => {
  it('reads currency, decimals and percentages', () => {
    expect(values('Premium is $17.45, about 3.2% of your floor.')).toEqual([17.45, 3.2]);
  });

  it('reads thousands separators as one number', () => {
    expect(values('Your floor is $2,300 on a $1,234.56 position.')).toEqual([2300, 1234.56]);
  });

  it('ignores ISO dates so calendar parts are not treated as claims', () => {
    expect(values('It expires 2026-09-11.')).toEqual([]);
  });

  it('ignores hex hashes and addresses', () => {
    expect(values('See 0xc15c6710abcdef0123 for the fill.')).toEqual([]);
  });

  it('reads a multiplier', () => {
    expect(values('That is 2.1x cheaper.')).toEqual([2.1]);
  });

  it('records the raw token so decimal precision survives', () => {
    const toks = extractNumbers('You paid $12.08.');
    expect(toks[0].raw).toBe('12.08');
    expect(toks[0].value).toBe(12.08);
  });

  it('returns nothing for prose with no digits', () => {
    expect(values('Your protection covers the full two weeks.')).toEqual([]);
  });
});
