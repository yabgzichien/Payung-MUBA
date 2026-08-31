import { describe, it, expect } from 'vitest';
import { checkGrounding, isGrounded } from '../src/grounding.js';

describe('isGrounded', () => {
  it('accepts a value rounded to the precision the model wrote', () => {
    expect(isGrounded({ raw: '12.08', value: 12.08, index: 0 }, [12.081192])).toBe(true);
  });

  it('accepts a coarser rounding of the same value', () => {
    expect(isGrounded({ raw: '12.1', value: 12.1, index: 0 }, [12.081192])).toBe(true);
  });

  it('accepts an exact integer', () => {
    expect(isGrounded({ raw: '2300', value: 2300, index: 0 }, [2300])).toBe(true);
  });

  it('rejects a plausible number that no tool returned', () => {
    expect(isGrounded({ raw: '15', value: 15, index: 0 }, [12.081192])).toBe(false);
  });

  it('rejects false precision beyond what the source supports', () => {
    // The source is 12.08 exactly; claiming 12.0812 invents digits.
    expect(isGrounded({ raw: '12.0812', value: 12.0812, index: 0 }, [12.08])).toBe(false);
  });
});

describe('checkGrounding', () => {
  it('passes prose whose every number came from a tool', () => {
    const r = checkGrounding('The premium is $17.45 for a $2,300 floor.', [17.45, 2300]);
    expect(r.ok).toBe(true);
    expect(r.ungrounded).toEqual([]);
  });

  it('flags the invented number and names it', () => {
    const r = checkGrounding('The premium is $17.45 and ETH will hit $4,000.', [17.45]);
    expect(r.ok).toBe(false);
    expect(r.ungrounded.map((t) => t.value)).toEqual([4000]);
  });

  it('passes prose with no numbers at all', () => {
    expect(checkGrounding('Nothing on the book covers your deadline.', []).ok).toBe(true);
  });

  it('accepts a number from an earlier tool call in the same turn', () => {
    // The allowlist accumulates across a turn, so an earlier spot read stays valid.
    const r = checkGrounding('Spot was $2,410 when I checked, and the premium is $17.45.', [2410, 17.45]);
    expect(r.ok).toBe(true);
  });
});
