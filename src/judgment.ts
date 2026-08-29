/**
 * The agent's judgment, computed — never guessed.
 *
 * This is the visible AI surface for Track 02 beyond intent parsing: comparing
 * premium to the value protected, and refusing to pretend a bad buy is a good
 * one. Deliberately NOT an LLM call: judgment over real numbers should be
 * deterministic and auditable. (Thresholds are the 5-10% rule from PROJECT.md.)
 */
import type { Quote } from './core';

export type Judgment = {
  /** Premium as a percentage of the floor value it protects (per contract). */
  premiumPctOfProtection: number;
  verdict: 'reasonable' | 'expensive' | 'not-worth-it';
  reasons: string[];
};

export function judgeQuote(q: Quote, coverageGapDays: number): Judgment {
  const pct = (q.pricePerContract / q.strike) * 100;
  const reasons: string[] = [];
  let verdict: Judgment['verdict'];

  if (pct > 10) {
    verdict = 'not-worth-it';
    reasons.push(
      `Premium is ${pct.toFixed(1)}% of the floor it protects — you would be paying more for the insurance than the insurance is worth. A floor further below spot costs far less.`
    );
  } else if (pct > 5) {
    verdict = 'expensive';
    reasons.push(
      `Premium is ${pct.toFixed(1)}% of the floor — on the expensive side, because this floor sits close to the current price. Your call.`
    );
  } else {
    verdict = 'reasonable';
    reasons.push(
      `Premium is ${pct.toFixed(1)}% of the floor it protects — reasonable for this distance and window.`
    );
  }

  if (coverageGapDays > 0.25) {
    reasons.push(
      `This protection ends ${coverageGapDays.toFixed(1)} days BEFORE your stated deadline (${q.expiry.toISOString().slice(0, 10)}). After that date you are unprotected.`
    );
  }
  return { premiumPctOfProtection: pct, verdict, reasons };
}
