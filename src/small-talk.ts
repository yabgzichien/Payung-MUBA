/**
 * Deterministic pre-check for chat turns that aren't a protection request but
 * still deserve a helpful reply — greetings and "what do I do" style meta
 * questions — instead of falling through to the LLM classifier's generic
 * rejection. Keyword-based, not LLM-based: zero added inference risk, and the
 * reply text is always a fixed canned string (see FlowState.tsx), never
 * model-generated prose.
 */
export type SmallTalkKind = 'greeting' | 'help' | 'floorPrice' | 'marketPrice';

const GREETINGS = ['hi', 'hello', 'hey', 'hiya', 'yo', 'sup', 'good morning', 'good afternoon', 'good evening'];

const HELP_PHRASES = [
  'help',
  'what should i do',
  'what do i do',
  'what can you do',
  'how does this work',
  'what now',
  'how do i use this',
  'what is this',
];

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[!.?]+$/g, '');
}

const QUESTION_STARTERS = ['what', "what's", 'whats', 'explain', 'define'];

function matches(normalized: string, phrases: string[]): boolean {
  return phrases.some((p) => normalized === p || normalized.startsWith(`${p} `));
}

/**
 * A glossary term only counts as a question ("what is floor price") — never
 * a statement that happens to use the same word while stating a real value
 * ("Protect 0.2 ETH at a $2,300 floor for 7 days").
 */
function matchesGlossaryTerm(normalized: string, keyword: string): boolean {
  return normalized.includes(keyword) && matches(normalized, QUESTION_STARTERS);
}

export function detectSmallTalk(text: string): SmallTalkKind | null {
  const normalized = normalize(text);
  if (matches(normalized, GREETINGS)) return 'greeting';
  if (matches(normalized, HELP_PHRASES)) return 'help';
  if (matchesGlossaryTerm(normalized, 'floor') || matchesGlossaryTerm(normalized, 'protected')) return 'floorPrice';
  if (matchesGlossaryTerm(normalized, 'market')) return 'marketPrice';
  return null;
}
