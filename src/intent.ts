/**
 * NL -> ProtectionSpec. The AI's ONLY job in the entire product (FR1).
 *
 * DESIGN RULE (the pitch, enforced in code): the LLM translates a sentence into
 * three fields and nothing else. Every field is strictly validated; every
 * number the user later sees comes from the live book, never from here.
 */
import type { ProtectionSpec } from './core.js';

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
Fields: "asset" ("ETH" or "BTC" — the asset they hold), "floorUsd" (number — the minimum USD value they need), "horizonDays" (number — how many days until their deadline).
"two weeks" means 14. "a month" means 30. "end of next week" means about 10.
If the text is NOT a request to protect a crypto holding's value, output {"error":"<one short sentence why>"}.
Never invent a floor or horizon that is not stated or clearly implied by the text.`;

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
    throw new Error(`Malformed response shape: expected a JSON object with "asset"/"floorUsd"/"horizonDays" fields, got: ${JSON.stringify(obj)}`);
  }
  if (!('asset' in obj) && !('floorUsd' in obj) && !('horizonDays' in obj)) {
    const keys = Object.keys(obj).join(', ') || 'none';
    throw new Error(`Malformed response shape: expected top-level "asset"/"floorUsd"/"horizonDays" fields but found none (got keys: ${keys}) — the model may have nested its answer under another key.`);
  }
  const asset = obj.asset;
  const floorUsd = Number(obj.floorUsd);
  const horizonDays = Number(obj.horizonDays);
  if (asset !== 'ETH' && asset !== 'BTC') {
    throw new Error(`Unsupported asset: ${JSON.stringify(obj.asset)} — Payung protects ETH or BTC.`);
  }
  if (!Number.isFinite(floorUsd) || floorUsd < 1 || floorUsd > 10_000_000) {
    throw new Error(`Implausible floor price: ${JSON.stringify(obj.floorUsd)}`);
  }
  if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 90) {
    throw new Error(`Horizon must be 1-90 days, got: ${JSON.stringify(obj.horizonDays)}`);
  }
  return { asset, floorUsd, horizonDays };
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
