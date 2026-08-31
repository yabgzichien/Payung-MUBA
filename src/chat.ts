/**
 * Tool-calling chat transport. Kept separate from agent.ts so the loop can be
 * unit-tested against a scripted fake with no network.
 *
 * Verified against Gonka Router with deepseek-ai/DeepSeek-V4-Flash-0731: the
 * endpoint returns finish_reason "tool_calls" with a well-formed tool_calls
 * array, so no ReAct-style JSON fallback is needed.
 */
export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ChatResponse = { content: string | null; toolCalls: ToolCall[] };

export type ChatClient = (messages: ChatMessage[], tools: unknown[]) => Promise<ChatResponse>;

export function gonkaChat(): ChatClient {
  const base = process.env.GONKA_BASE_URL ?? 'https://api.gonkarouter.io/v1';
  const key = process.env.GONKA_API_KEY;
  const model = process.env.GONKA_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash-0731';
  if (!key) throw new Error('GONKA_API_KEY missing in .env — see .env.example.');

  return async (messages, tools) => {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0, messages, tools, tool_choice: 'auto' }),
    });
    if (!res.ok) throw new Error(`Gonka Router ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    const msg = json.choices?.[0]?.message ?? {};
    return { content: msg.content ?? null, toolCalls: msg.tool_calls ?? [] };
  };
}
