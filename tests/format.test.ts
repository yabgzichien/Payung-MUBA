import { describe, expect, it } from 'vitest';
import { contracts, describeJudgment, pluralDays, usd, usdWhole } from '../app/protect/_lib/format';

describe('pluralDays', () => {
  /**
   * The regression: expiryNote was built as "Ends N day(s) early" and then
   * composed into "⚠️ Ends {note.toLowerCase()}", which shipped the literal
   * string "Ends ends 3 day(s) early." to users on the results screen.
   */
  it('pluralises instead of emitting a "day(s)" placeholder', () => {
    expect(pluralDays(1)).toBe('1 day');
    expect(pluralDays(3)).toBe('3 days');
    expect(pluralDays(0)).toBe('1 day');
    expect(pluralDays(2.4)).toBe('2 days');
  });

  it('composes into a fragment that reads correctly after a prefix', () => {
    const note = `Ends ${pluralDays(3)} early`;
    expect(`This option ${note.toLowerCase()}.`).toBe('This option ends 3 days early.');
    expect(note).not.toMatch(/day\(s\)/);
  });
});

describe('money formatting', () => {
  it('always renders two decimals for premiums', () => {
    expect(usd(29.999997613)).toBe('$30.00');
    expect(usd(2)).toBe('$2.00');
  });

  it('renders strikes as whole dollars with separators', () => {
    expect(usdWhole(2300)).toBe('$2,300');
    expect(usdWhole(76000.4)).toBe('$76,000');
  });
});

describe('contracts', () => {
  it('does not pad an exact quantity with zeros', () => {
    expect(contracts(0.2)).toBe('0.2');
    expect(contracts(1)).toBe('1');
  });

  it('keeps precision on a partial fill', () => {
    expect(contracts(0.19834)).toBe('0.1983');
  });
});

describe('describeJudgment', () => {
  it('turns a bare premium into a share of protected value', () => {
    const j = describeJudgment({ premiumPctOfProtection: 1.3, verdict: 'reasonable' });
    expect(j.label).toBe('Reasonably priced');
    expect(j.tone).toBe('good');
    expect(j.sentence).toBe("1.30% of the value you're protecting");
  });

  it('flags poor value distinctly from merely expensive', () => {
    expect(describeJudgment({ premiumPctOfProtection: 9, verdict: 'expensive' }).tone).toBe('warn');
    expect(describeJudgment({ premiumPctOfProtection: 22, verdict: 'not-worth-it' }).tone).toBe('bad');
  });

  it('degrades gracefully on an unrecognised verdict', () => {
    const j = describeJudgment({ premiumPctOfProtection: 3, verdict: 'something-new' });
    expect(j.label).toBe('something-new');
    expect(j.tone).toBe('warn');
  });
});
