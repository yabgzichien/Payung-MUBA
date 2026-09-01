// tests/eval/grounding-eval.test.ts
//
// Adversarial cases for the numeric-grounding guard (src/grounding.ts),
// added alongside the intent eval suite because the brief's own test file
// (intent-eval.test.ts) doesn't exercise checkGrounding at all.
//
// Every case here was hand-traced against the real checkGrounding/isGrounded/
// extractNumbers implementation before being committed — see the "false
// sign" case below for the one spot where the obvious assertion doesn't
// match the real, already-reviewed behavior.
import { describe, it, expect } from 'vitest';
import { checkGrounding } from '../../src/grounding.js';

describe('grounding eval — adversarial cases', () => {
  it('rejects a plausible-but-absent premium figure', () => {
    const r = checkGrounding('The premium is $19.99 for this floor.', [17.45, 2300]);
    expect(r.ok).toBe(false);
  });

  it('rejects a correct number stated at false precision', () => {
    // Source is 12.08 exactly; claiming 12.0812 invents digits.
    const r = checkGrounding('You paid exactly $12.0812.', [12.08]);
    expect(r.ok).toBe(false);
  });

  it('accepts a number that appeared only in an EARLIER tool call this turn', () => {
    // allowedNumbers accumulates across a turn, so an earlier spot price stays valid later.
    const r = checkGrounding('As I mentioned, spot was $2,410 a moment ago.', [2410, 17.45]);
    expect(r.ok).toBe(true);
  });

  it('rejects a negative delta phrased without a literal minus sign', () => {
    // Corrected from the planned assertion (expect ok===true). Hand-trace against
    // the real extractNumbers/isGrounded:
    //   - "$7.00" contains no "-" character in the source text, so the token
    //     extracted is {raw: "7.00", value: 7}, NOT -7. The word "cheaper"
    //     carries the negative sense in English, but checkGrounding does no
    //     semantic sign inference from surrounding prose — it only matches the
    //     literal digits (and an explicit leading "-") the model wrote.
    //   - isGrounded then checks whether some allowed value, rounded to 2
    //     decimals (the precision of "7.00"), equals 7. The only allowed value
    //     is -7, and (-7).toFixed(2) = "-7.00" -> -7, which is !== 7.
    //   - So checkGrounding returns { ok: false, ungrounded: [{value: 7, ...}] },
    //     not ok: true as originally assumed.
    // This is a real (if narrow) gap in the guard: a model asserting a signed
    // delta in prose without the literal minus sign will get flagged as
    // ungrounded even when the magnitude is correct and the allowed list has
    // the true signed value. Filed as a discrepancy, not silently patched —
    // src/grounding.ts is out of scope here. A model that wants credit for a
    // negative delta must write the sign (e.g. "-$7.00" or "a $-7 change"),
    // or the allowed list must additionally include the unsigned magnitude.
    const r = checkGrounding('Full coverage is actually $7.00 cheaper here.', [-7]);
    expect(r.ok).toBe(false);
    expect(r.ungrounded.map((t) => t.value)).toEqual([7]);
  });

  it('rejects a fabricated price prediction', () => {
    const r = checkGrounding('ETH is at $2,410 and will likely hit $4,000 by then.', [2410]);
    expect(r.ok).toBe(false);
    expect(r.ungrounded.map((t) => t.value)).toEqual([4000]);
  });

  it('passes prose with no numeric claims at all', () => {
    const r = checkGrounding('Nothing on the live book covers your full deadline.', []);
    expect(r.ok).toBe(true);
  });
});
