// tests/eval/grounding-eval.test.ts
//
// Adversarial cases for the numeric-grounding guard (src/grounding.ts),
// added alongside the intent eval suite because the brief's own test file
// (intent-eval.test.ts) doesn't exercise checkGrounding at all.
//
// Every case here was hand-traced against the real checkGrounding/isGrounded/
// extractNumbers implementation before being committed — see the "negative
// delta phrased without a literal minus sign" case below, which exercises
// isGrounded's unsigned-vs-negative-allowed-value widening (added in a later
// fix round after this suite first surfaced the gap).
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

  it('accepts a negative delta phrased without a literal minus sign', () => {
    // Originally this test asserted ok: false, with a hand-trace showing a
    // real gap: "$7.00" contains no "-" character, so extractNumbers reads
    // the unsigned token {raw: "7.00", value: 7}, and the old isGrounded only
    // matched a token's exact signed value against a rounded allowed value —
    // so an allowed list of [-7] could never ground it, even though "$7.00
    // cheaper" is exactly what a correctly-grounded negative delta of -7
    // looks like in natural English (nobody says "the premium is -$7.00").
    //
    // src/grounding.ts's isGrounded was subsequently widened (see its
    // docstring) to accept an unsigned token against the negation of a
    // signed allowed value, while still requiring an explicitly-signed token
    // ("-$7.00") to match a signed allowed value exactly. Re-traced against
    // the fixed implementation:
    //   - decimalsOf("7.00") = 2, isSigned = false (no leading "-").
    //   - allowed = [-7]; rounded = (-7).toFixed(2) -> Number("-7.00") = -7.
    //   - rounded (-7) !== tok.value (7), so the direct match fails as before.
    //   - the widening then checks !isSigned && -rounded === tok.value:
    //     -(-7) = 7 === 7 -> true. So isGrounded now returns true, and
    //     checkGrounding returns { ok: true, ungrounded: [] }.
    const r = checkGrounding('Full coverage is actually $7.00 cheaper here.', [-7]);
    expect(r.ok).toBe(true);
    expect(r.ungrounded).toEqual([]);
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
