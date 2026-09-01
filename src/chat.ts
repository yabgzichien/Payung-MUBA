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

import { callGroqChatCompletions } from './groq';

export function groqChat(): ChatClient {
  const base = process.env.GROQ_BASE_URL ?? process.env.GONKA_BASE_URL ?? 'https://api.groq.com/openai/v1';
  const key = process.env.GROQ_API_KEY ?? process.env.GONKA_API_KEY;
  const model = process.env.GROQ_MODEL ?? process.env.GONKA_MODEL ?? 'openai/gpt-oss-120b';
  if (!key) throw new Error('GROQ_API_KEY missing in .env — see .env.example.');

  return async (messages, tools) => {
    const json = await callGroqChatCompletions({
      base,
      key,
      body: { model, temperature: 0, messages, tools, tool_choice: 'auto' },
    });
    const msg = json.choices?.[0]?.message ?? {};
    return { content: msg.content ?? null, toolCalls: msg.tool_calls ?? [] };
  };
}

export const gonkaChat = groqChat;
