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

/** Strict validation — the only gate between LLM output and the product. Pure; reused by the server. */
export function validateSpec(obj: any): ProtectionSpec {
  const asset = obj?.asset;
  const floorUsd = Number(obj?.floorUsd);
  const horizonDays = Number(obj?.horizonDays);
  if (asset !== 'ETH' && asset !== 'BTC') {
    throw new Error(`Unsupported asset: ${JSON.stringify(obj?.asset)} — Payung protects ETH or BTC.`);
  }
  if (!Number.isFinite(floorUsd) || floorUsd < 1 || floorUsd > 10_000_000) {
    throw new Error(`Implausible floor price: ${JSON.stringify(obj?.floorUsd)}`);
  }
  if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 90) {
    throw new Error(`Horizon must be 1-90 days, got: ${JSON.stringify(obj?.horizonDays)}`);
  }
  return { asset, floorUsd, horizonDays };
}

export async function parseIntent(text: string, llm: LlmClient): Promise<ProtectionSpec> {
  const out = await llm(SYSTEM, text);
  const match = out.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse intent: the model returned no JSON.');
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    throw new Error('Could not parse intent: the model returned invalid JSON.');
  }
  if (obj.error) throw new Error(`Not a protection request: ${obj.error}`);
  return validateSpec(obj);
}
