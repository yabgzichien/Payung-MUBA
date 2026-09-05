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
  {
    card: 'quote-options',
    re: /\b(recommended|the best|best one|first (one|option)?|top pick|option 1|choice 1|pick (the )?first|select (the )?first|select (the )?recommended)\b/i,
    command: { type: 'select', tier: 'recommended' },
  },
  {
    card: 'quote-options',
    re: /\b(cheaper|cheapest|the second|second (one|option)?|alternative|option 2|choice 2|pick (the )?second|select (the )?second|select (the )?cheaper)\b/i,
    command: { type: 'select', tier: 'cheaper' },
  },
  {
    card: 'quote-options',
    re: /\b(explore|different (floor|protected price|strike|price)?|another (floor|protected price|strike|price)?|other (floors|protected prices|strikes|prices)?|custom (floor|protected price)?|show (other |more )?(floors|prices|chart))\b/i,
    command: { type: 'explore' },
  },
  {
    card: 'confirm-summary',
    re: /\b(confirm|yes|buy( it)?|go ahead|proceed|looks good|looks great|continue|let'?s do it|sure|ok|okay)\b/i,
    command: { type: 'confirm' },
  },
  {
    card: 'confirm-summary',
    re: /\b(back|go back|return|previous|change (the )?(option|protection)|different (option|protection))\b/i,
    command: { type: 'back' },
  },
  {
    card: 'connect-wallet',
    re: /\b(connect( my)? wallet|connect|sign in|login)\b/i,
    command: { type: 'connect' },
  },
  {
    card: 'review-execute',
    re: /\b(check|preflight|dry run|verify|simulate|test)\b/i,
    command: { type: 'preflight' },
  },
  {
    card: 'review-execute',
    re: /\b(execute|buy( it)?|confirm|place( the)? order|proceed|go ahead|submit|sign)\b/i,
    command: { type: 'execute' },
  },
];

export function matchLightCommand(card: ChatCardKind | null, text: string): LightCommand | null {
  if (!card) return null;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  // If the user is adjusting parameters (e.g. "what about 2300 for 10 weeks", "change to 2 ETH"),
  // prioritize goal parsing rather than treating it as a button shortcut.
  const hasParamAdjustment =
    /\b\d+(\.\d+)?\b/.test(normalized) &&
    /\b(eth|btc|days?|weeks?|months?|floor|protected|price|keep|protect|what about|how about|try|change to|want)\b/i.test(
      normalized
    );
  if (hasParamAdjustment) return null;

  const hit = PATTERNS.find((p) => p.card === card && p.re.test(normalized));
  return hit ? hit.command : null;
}
