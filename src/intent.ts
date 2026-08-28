/**
 * NL -> ProtectionSpec. The AI's ONLY job in the entire product (FR1).
 *
 * DESIGN RULE (the pitch, enforced in code): the LLM transcribes a sentence
 * into four fields and nothing else — asset, quantity, floorTotalUsd,
 * horizonDays. It is explicitly forbidden from dividing or multiplying, so
 * the per-unit strike a match is ranked against is derived in tested code
 * (impliedStrike), never by the model. Every field is strictly validated;
 * every number the user later sees comes from the live book, never from here.
 */
// From './spec.js', NOT './core.js' — impliedStrike is used at runtime here,
// and a value import of core.ts would pull dotenv + the Thetanuts SDK into
// this module and into the zero-network intent tests (HANDOFF.md rule 1).
import { impliedStrike, type ProtectionSpec } from './spec.js';

export type LlmClient = (system: string, user: string) => Promise<string>;

/** OpenAI-compatible chat-completions transport for Gonka Router. */
export function gonkaLlm(): LlmClient {
  const base = process.env.GONKA_BASE_URL ?? 'https://api.gonkarouter.io/v1';
  const key = process.env.GONKA_API_KEY;
  const model = process.env.GONKA_MODEL ?? 'moonshotai/Kimi-K2.6';
  if (!key) throw new Error('GONKA_API_KEY missing in .env — see .env.example.');
  return async (system, user) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Gonka Router ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return json.choices?.[0]?.message?.content ?? '';
  };
}

const SYSTEM = `You translate a user's crypto-protection request into JSON. Output ONLY a JSON object, nothing else.
Fields:
- "asset" ("ETH" or "BTC" — the asset they hold)
- "quantity" (number — how much of the asset they hold)
- "floorTotalUsd" (number — the total USD value they need their WHOLE holding to be worth)
- "horizonDays" (number — how many days until their deadline)
"two weeks" means 14. "a month" means 30. "end of next week" means about 10.
Do NOT divide, multiply, or otherwise compute a per-unit price. Report only the numbers as stated or clearly implied — quantity and floorTotalUsd are separate, literal transcriptions, never derived from each other.
If the text is NOT a request to protect a crypto holding's value, output {"error":"<one short sentence why>"}.
Never invent a quantity, floor, or horizon that is not stated or clearly implied by the text.`;

/**
 * Scan for the first complete, balanced `{...}` block in a string, tracking
 * brace depth by hand so that braces inside JSON string literals (including
 * escaped quotes) never desync the count.
 *
 * This replaces a naive `/\{[\s\S]*\}/` greedy regex, which spans from the
 * FIRST `{` to the LAST `}` in the entire response. That greedy span breaks
 * whenever the model's output contains more than one top-level `{...}` — e.g.
 * echoing a format example before its real answer — because it swallows both
 * objects plus everything between them and fails to parse as JSON at all.
 *
 * Scanning for the first *balanced* block instead means: if the model emits
 * a format example followed by its real answer, we get the (possibly wrong)
 * first object rather than a parse error — a plain, attributable "bad shape"
 * failure the user can retry, not a crash. That first-object ambiguity is
 * inherent to extracting structured data from unstructured prose; no scanner
 * can fully resolve it. What this DOES fully fix is a single nested object
 * (e.g. `{"result": {...}}`) parsing without error while silently losing the
 * real fields — see the shape check in validateSpec below.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // unbalanced / truncated — never resolved back to depth 0
}

/** Strict validation — the only gate between LLM output and the product. Pure; reused by the server. */
export function validateSpec(obj: any): ProtectionSpec {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`Malformed response shape: expected a JSON object with "asset"/"quantity"/"floorTotalUsd"/"horizonDays" fields, got: ${JSON.stringify(obj)}`);
  }
  if (!('asset' in obj) && !('quantity' in obj) && !('floorTotalUsd' in obj) && !('horizonDays' in obj)) {
    const keys = Object.keys(obj).join(', ') || 'none';
    throw new Error(`Malformed response shape: expected top-level "asset"/"quantity"/"floorTotalUsd"/"horizonDays" fields but found none (got keys: ${keys}) — the model may have nested its answer under another key.`);
  }
  const asset = obj.asset;
  const quantity = Number(obj.quantity);
  const floorTotalUsd = Number(obj.floorTotalUsd);
  const horizonDays = Number(obj.horizonDays);
  if (asset !== 'ETH' && asset !== 'BTC') {
    throw new Error(`Unsupported asset: ${JSON.stringify(obj.asset)} — Payung protects ETH or BTC.`);
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`I need to know how much ${asset} you hold — missing or invalid quantity: ${JSON.stringify(obj.quantity)}`);
  }
  if (!Number.isFinite(floorTotalUsd) || floorTotalUsd < 1 || floorTotalUsd > 10_000_000_000) {
    throw new Error(`Implausible total floor value: ${JSON.stringify(obj.floorTotalUsd)}`);
  }
  if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 90) {
    throw new Error(`Horizon must be 1-90 days, got: ${JSON.stringify(obj.horizonDays)}`);
  }
  const spec: ProtectionSpec = { asset, quantity, floorTotalUsd, horizonDays };
  const strike = impliedStrike(spec);
  if (!Number.isFinite(strike) || strike < 1 || strike > 10_000_000) {
    throw new Error(
      `Implied per-unit strike ($${floorTotalUsd} / ${quantity} ${asset} = $${Number.isFinite(strike) ? strike.toFixed(2) : strike}) is implausible — check your quantity and total value.`
    );
  }
  return spec;
}

export async function parseIntent(text: string, llm: LlmClient): Promise<ProtectionSpec> {
  const out = await llm(SYSTEM, text);
  const candidate = extractFirstJsonObject(out);
  if (!candidate) throw new Error('Could not parse intent: the model returned no JSON.');
  let obj: any;
  try {
    obj = JSON.parse(candidate);
  } catch {
    throw new Error('Could not parse intent: the model returned invalid JSON.');
  }
  if (obj.error) throw new Error(`Not a protection request: ${obj.error}`);
  return validateSpec(obj);
}
