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
import { impliedStrike, totalFromUnit, type ProtectionSpec } from './spec';
import { callGroqChatCompletions } from './groq';

export type LlmClient = (system: string, user: string) => Promise<string>;

/** OpenAI-compatible chat-completions transport for Groq. */
export function groqLlm(): LlmClient {
  const base = process.env.GROQ_BASE_URL ?? process.env.GONKA_BASE_URL ?? 'https://api.groq.com/openai/v1';
  const key = process.env.GROQ_API_KEY ?? process.env.GONKA_API_KEY;
  const model = process.env.GROQ_MODEL ?? process.env.GONKA_MODEL ?? 'openai/gpt-oss-120b';
  if (!key) throw new Error('GROQ_API_KEY missing in .env — see .env.example.');
  return async (system, user) => {
    const json = await callGroqChatCompletions({
      base,
      key,
      body: {
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    });
    return json.choices?.[0]?.message?.content ?? '';
  };
}

export const gonkaLlm = groqLlm;

const SYSTEM = `You translate a user's crypto-protection request into JSON. Output ONLY a JSON object, nothing else.
Fields:
- "asset" ("ETH" or "BTC" — the asset they hold)
- "quantity" (number — how much of the asset they hold or want to protect, e.g. "1 ETH", "0.2 BTC", "keep 1 ETH")
- "floorTotalUsd" (number — the total USD value they need their WHOLE holding to be worth)
- "horizonDays" (number — how many days until their deadline)
"two weeks" means 14. "a month" means 30. "end of next week" means about 10.
Do NOT divide, multiply, or otherwise compute a per-unit price. Report only the numbers as stated or clearly implied — quantity and floorTotalUsd are separate, literal transcriptions, never derived from each other.
If the text is NOT a request to protect a crypto holding's value, output {"error":"<one short sentence why>"}.
Never invent a quantity, floor, or horizon that is not stated or clearly implied by the text.`;

/**
 * Nullable-field variant of SYSTEM, for the web UI's incremental sentence box
 * (parsePartialIntent below). Unlike SYSTEM, an unstated field is reported as
 * null rather than forcing the whole request to fail — see classifyPartialSpec.
 * Also adds floorMode so a per-unit market price (e.g. "BTC not below
 * $62,000") isn't misread as a total holding value: the model only TAGS which
 * one the sentence means, never computes between them (totalFromUnit/
 * impliedStrike do that in tested code).
 */
const SYSTEM_PARTIAL = `You translate a user's crypto-protection request into JSON. Output ONLY a JSON object, nothing else.
Fields — use null for any field the text does not state or clearly imply. Never guess or invent a value:
- "asset" (the symbol they hold, exactly as named, e.g. "ETH", "BTC", or any other ticker they mention — or null)
- "quantity" (number — how much of the asset they hold or want to protect, e.g. "1 ETH", "0.2 BTC", "keep 1 ETH", "protect my 2 ETH" gives quantity 1, 0.2, 2. If no amount to protect is mentioned, e.g. "keep ETH above $2,000", "protect ETH", use null)
- "floorValue" (number — the price they mention — or null)
- "floorMode" ("perUnit" if floorValue is the price of ONE unit of the asset — e.g. "the BTC price", "per ETH", "market price of $X", "not fall below $X", "above $X", "at $X" with no "total" wording — or "total" if floorValue is the value of their WHOLE holding — e.g. "worth $X total", "my holding worth $X". null if floorValue is null.)
- "horizonDays" (number — how many days until their deadline — or null)
"two weeks" means 14. "a month" means 30. "end of next week" means about 10.
Important: phrasing like "Keep 1 ETH above $2,200", "Protect 0.2 ETH at $2,300", or "1 ETH above $2,200" specifies BOTH the quantity (1 ETH, 0.2 ETH) and the per-unit floor price ($2,200, $2,300). Do NOT leave quantity as null when an amount like "1 ETH" is stated.
Do NOT divide, multiply, or otherwise compute floorValue from quantity or vice versa — report only the number as stated.
Only output {"error":"<one short sentence why>"} when the text is not about protecting a crypto holding's value AT ALL (e.g. an unrelated question or a joke). If it IS a protection request but names an asset other than ETH/BTC, still fill in every other field normally — do NOT use the error field just because the asset is unsupported.`;

export type FieldKey = 'asset' | 'quantity' | 'floor' | 'horizonDays';

export type PartialSpecResult = {
  asset: 'ETH' | 'BTC' | null;
  quantity: number | null;
  unitFloorUsd: number | null;
  floorTotalUsd: number | null;
  horizonDays: number | null;
  /** Fields the sentence never mentioned — highlight, don't error. */
  missingFields: FieldKey[];
  /** Fields the sentence stated but with a bad value — show next to that field only. */
  fieldErrors: Partial<Record<FieldKey, string>>;
};

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

/**
 * Per-field classification for the web UI's sentence box: unlike validateSpec,
 * an unstated field goes to missingFields (highlight and let the user fill it
 * in) rather than failing the whole parse. A field that WAS stated but is bad
 * goes to fieldErrors instead, so the two cases stay visibly different in the
 * form (see intent.test.ts for the field-level cases this covers).
 */
export function classifyPartialSpec(obj: any): PartialSpecResult {
  const missingFields: FieldKey[] = [];
  const fieldErrors: Partial<Record<FieldKey, string>> = {};

  let asset: 'ETH' | 'BTC' | null = null;
  if (obj.asset == null) {
    missingFields.push('asset');
  } else if (obj.asset !== 'ETH' && obj.asset !== 'BTC') {
    fieldErrors.asset = `Unsupported asset: ${JSON.stringify(obj.asset)} — Payung protects ETH or BTC.`;
  } else {
    asset = obj.asset;
  }

  let quantity: number | null = null;
  if (obj.quantity == null) {
    missingFields.push('quantity');
  } else {
    const q = Number(obj.quantity);
    if (!Number.isFinite(q) || q <= 0) {
      fieldErrors.quantity = `Quantity must be a positive number, got: ${JSON.stringify(obj.quantity)}`;
    } else {
      quantity = q;
    }
  }

  let unitFloorUsd: number | null = null;
  let floorTotalUsd: number | null = null;
  if (obj.floorValue == null) {
    missingFields.push('floor');
  } else {
    const v = Number(obj.floorValue);
    if (!Number.isFinite(v) || v <= 0) {
      fieldErrors.floor = `Floor value must be a positive number, got: ${JSON.stringify(obj.floorValue)}`;
    } else if (obj.floorMode === 'perUnit') {
      unitFloorUsd = v;
      if (quantity != null) floorTotalUsd = totalFromUnit(v, quantity);
    } else if (obj.floorMode === 'total') {
      floorTotalUsd = v;
      if (quantity != null) unitFloorUsd = v / quantity;
    } else {
      fieldErrors.floor = `Could not tell if $${v} is a per-unit price or a total holding value — try stating "per BTC/ETH" or "total" explicitly.`;
    }
  }

  let horizonDays: number | null = null;
  if (obj.horizonDays == null) {
    missingFields.push('horizonDays');
  } else {
    const h = Number(obj.horizonDays);
    if (!Number.isFinite(h) || h < 1 || h > 90) {
      fieldErrors.horizonDays = `Horizon must be 1-90 days, got: ${JSON.stringify(obj.horizonDays)}`;
    } else {
      horizonDays = h;
    }
  }

  // Plausibility of the implied per-unit strike can only be checked once both
  // sides of the division are known and the floor didn't already fail above.
  if (!fieldErrors.floor && quantity != null && floorTotalUsd != null) {
    const strike = impliedStrike({ asset: asset ?? 'ETH', quantity, floorTotalUsd, horizonDays: horizonDays ?? 1 });
    if (!Number.isFinite(strike) || strike < 1 || strike > 10_000_000) {
      fieldErrors.floor = `Implied per-unit strike ($${floorTotalUsd} / ${quantity} = $${strike.toFixed(2)}) is implausible — check your quantity and floor value.`;
      unitFloorUsd = null;
      floorTotalUsd = null;
    }
  }

  return { asset, quantity, unitFloorUsd, floorTotalUsd, horizonDays, missingFields, fieldErrors };
}

/**
 * Join prior conversation turns with the newest one into a single sentence
 * for parsePartialIntent. Without this, each chat message is parsed as an
 * amnesiac one-off — a follow-up like "I currently have 0.01 ETH" says
 * nothing about "protecting" on its own and gets misread as off-topic. The
 * model needs the whole conversation, not just the latest fragment.
 */
export function combineGoalText(priorTurns: string[], text: string): string {
  return [...priorTurns, text]
    .map((t) => t.trim())
    .filter(Boolean)
    .join(' ');
}

export async function parsePartialIntent(text: string, llm: LlmClient): Promise<PartialSpecResult> {
  const out = await llm(SYSTEM_PARTIAL, text);
  const candidate = extractFirstJsonObject(out);
  if (!candidate) throw new Error('Could not parse intent: the model returned no JSON.');
  let obj: any;
  try {
    obj = JSON.parse(candidate);
  } catch {
    throw new Error('Could not parse intent: the model returned invalid JSON.');
  }
  if (obj.error) throw new Error(`Not a protection request: ${obj.error}`);
  return classifyPartialSpec(obj);
}
