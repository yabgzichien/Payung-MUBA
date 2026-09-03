/** Presentation helpers shared across the flow. Pure — no React, no DOM. */

/**
 * Whether the automated-roll module is configured for this deployment.
 *
 * Read at module scope because Next.js inlines NEXT_PUBLIC_* at build time —
 * a dynamic `process.env[name]` lookup would not be substituted. When false,
 * every Precise Protection entry point degrades to an explanation instead of
 * letting the user start a flow that cannot finish.
 */
export const PRECISE_MODULE_ADDRESS = process.env.NEXT_PUBLIC_PAYUNG_ROLL_MODULE_ADDRESS ?? '';

export const preciseProtectionAvailable = /^0x[0-9a-fA-F]{40}$/.test(PRECISE_MODULE_ADDRESS);

/** "1 day" / "3 days". Replaces the "day(s)" placeholder that shipped to users. */
export function pluralDays(n: number): string {
  const rounded = Math.max(1, Math.round(n));
  return `${rounded} ${rounded === 1 ? 'day' : 'days'}`;
}

/** Money, always two decimals, never in scientific notation. */
export function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Whole-dollar figures — strikes, spot, floors. */
export function usdWhole(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * Contract counts. `toFixed(4)` rendered a clean 0.2 as "0.2000"; this keeps
 * enough precision to be honest about a partial fill without padding zeros
 * onto an exact one.
 */
export function contracts(n: number): string {
  const s = n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return s;
}

const VERDICT_COPY: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' }> = {
  reasonable: { label: 'Reasonably priced', tone: 'good' },
  expensive: { label: 'Expensive', tone: 'warn' },
  'not-worth-it': { label: 'Poor value', tone: 'bad' },
};

/**
 * Turns the judgment the API already computes into something a user can act
 * on. A premium is meaningless as a bare number — "$29.99" says nothing until
 * you know it is 1.3% of what is being protected.
 */
export function describeJudgment(j: { premiumPctOfProtection: number; verdict: string }) {
  const meta = VERDICT_COPY[j.verdict] ?? { label: j.verdict, tone: 'warn' as const };
  return {
    label: meta.label,
    tone: meta.tone,
    pct: `${j.premiumPctOfProtection.toFixed(2)}%`,
    sentence: `${j.premiumPctOfProtection.toFixed(2)}% of the value you're protecting`,
  };
}
