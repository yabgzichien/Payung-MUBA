import type { ChatCardKind } from './types';

/**
 * Free-text shortcuts for the currently visible card. Deliberately narrow —
 * cards are the primary way to act, this just lets the obvious phrase for a
 * visible button ("connect my wallet", "the cheaper one") work too. Not a
 * general intent parser: unmatched text falls back to small talk or a
 * "tap an option above" reply, never a silent reinterpretation as a new goal.
 */
export type LightCommand =
  | { type: 'select'; tier: 'recommended' | 'cheaper' }
  | { type: 'explore' }
  | { type: 'confirm' }
  | { type: 'back' }
  | { type: 'connect' }
  | { type: 'preflight' }
  | { type: 'execute' };

const PATTERNS: { card: ChatCardKind; re: RegExp; command: LightCommand }[] = [
  { card: 'quote-options', re: /\b(recommended|the best|best one|first (one|option))\b/, command: { type: 'select', tier: 'recommended' } },
  { card: 'quote-options', re: /\b(cheaper|the second|second one|alternative)\b/, command: { type: 'select', tier: 'cheaper' } },
  { card: 'quote-options', re: /\b(explore|different (floor|protected price)|another (floor|protected price)|other (floors|protected prices)|custom (floor|protected price))\b/, command: { type: 'explore' } },
  { card: 'confirm-summary', re: /\b(confirm|yes|buy( it)?|go ahead|proceed|looks good)\b/, command: { type: 'confirm' } },
  { card: 'confirm-summary', re: /\b(back|change|different (option|protection))\b/, command: { type: 'back' } },
  { card: 'connect-wallet', re: /\b(connect( my)? wallet|connect)\b/, command: { type: 'connect' } },
  { card: 'review-execute', re: /\b(check|preflight|dry run)\b/, command: { type: 'preflight' } },
  { card: 'review-execute', re: /\b(execute|buy( it)?|confirm|place( the)? order|proceed|go ahead)\b/, command: { type: 'execute' } },
];

export function matchLightCommand(card: ChatCardKind | null, text: string): LightCommand | null {
  if (!card) return null;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  const hit = PATTERNS.find((p) => p.card === card && p.re.test(normalized));
  return hit ? hit.command : null;
}
