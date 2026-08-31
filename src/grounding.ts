/**
 * The numeric grounding guard.
 *
 * Payung's headline claim is that the LLM never generates a number the user
 * sees. Before the agent loop that was true by construction: the model emitted
 * four transcribed fields and nothing else. Chat prose contains numbers, so the
 * claim survives only if it is ENFORCED. This module is that enforcement, and
 * it turns an asserted property into a demonstrable one.
 *
 * Pure. No I/O, no model, no SDK.
 */

export type NumberToken = { raw: string; value: number; index: number };

/**
 * Blank out spans whose digits are not numeric claims, before extraction.
 *
 * ISO dates and hex hashes both contain digit runs that would otherwise be read
 * as fabricated figures ("2026-09-11" -> 2026, 9, 11). Both are copied verbatim
 * from tool data and carry no arithmetic meaning. Replacing them with spaces
 * (not deleting) keeps every surviving token's index accurate.
 */
export function maskNonNumeric(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]+/g, (m) => ' '.repeat(m.length))
    .replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, (m) => ' '.repeat(m.length));
}

/**
 * Numbers with optional thousands separators, optional decimal part, and an
 * optional leading minus sign — but the sign only counts when it isn't glued
 * to a preceding word character. That guard is what stops this from
 * misreading a range ("10-20" must stay [10, 20], not [10, -20]: the dash is
 * preceded by the digit "0", a word character, so no match starts there) or a
 * hyphenated compound ID ("TNU-AUDIT-0046" must extract as 46, not -46: the
 * dash is preceded by the letter "T"). A genuine negative number is written
 * with the sign preceded by whitespace, punctuation, or nothing (start of
 * string) — never glued to a letter or digit.
 */
const NUMBER_PATTERN = /(?<!\w)-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<!\w)-?\d+(?:\.\d+)?/g;

export function extractNumbers(text: string): NumberToken[] {
  const masked = maskNonNumeric(text);
  const out: NumberToken[] = [];
  for (const m of masked.matchAll(NUMBER_PATTERN)) {
    const raw = m[0].replace(/,/g, '');
    const value = Number.parseFloat(raw);
    if (Number.isFinite(value)) out.push({ raw, value, index: m.index ?? 0 });
  }
  return out;
}
