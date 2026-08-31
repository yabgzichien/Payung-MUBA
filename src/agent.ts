/**
 * The bounded agent loop.
 *
 * The model decides WHICH action to take next; it never computes a value. Every
 * number reaching the user comes from a tool's declared `numbers` array and is
 * checked by the grounding guard before it is surfaced.
 *
 * Tools are injected rather than imported so this module — and its tests — stay
 * free of the SDK.
 */
import type { ChatClient, ChatMessage } from './chat';
import { checkGrounding, extractNumbers } from './grounding';
import type { ToolDef, ToolContext } from './tools';

export const MAX_ROUNDS = 8;

export const SYSTEM_PROMPT = `You are Payung, an agent that helps someone put a price floor under crypto they already hold, using real put options on the live Thetanuts orderbook on Base mainnet.

HARD RULES:
- You may NOT do arithmetic. Never add, subtract, multiply, divide, or estimate.
- Every number you write must have come back from a tool call in this conversation, or have been stated by the user. If you need a number you do not have, call a tool.
- Never predict a price or offer a market view. You have no edge and it is not your job.
- If find_protection returns nothing, say so plainly and offer to loosen ONE constraint (a lower floor, or a different deadline). Never substitute a different option and describe it as what they asked for.
- If an option expires before the user's deadline, say how many days short it is before discussing anything else about it.
- propose_execution is your only terminal action, and it only prepares a transaction for the user to sign themselves. You cannot spend their money.

Be brief and concrete. Talk about dollars and dates, not options jargon.`;

export type Violation = { attempt: number; tokens: number[]; text: string };

export type AgentState = {
  messages: ChatMessage[];
  allowedNumbers: number[];
  ctx: ToolContext;
  reply: string;
  violations: Violation[];
  rounds: number;
};

export function newAgentState(): AgentState {
  return {
    messages: [{ role: 'system', content: SYSTEM_PROMPT }],
    allowedNumbers: [],
    ctx: { candidates: new Map(), spec: null, signerAddress: null },
    reply: '',
    violations: [],
    rounds: 0,
  };
}

const FALLBACK =
  'I could not put together an answer I can stand behind from live data just now. ' +
  'Try asking again, or use the form to pick a floor directly.';

/**
 * checkGrounding delegates to isGrounded, which calls `Number(v.toFixed(d))`
 * where `d` is the number of fractional digits the MODEL wrote in its own
 * output — unbounded, and NOT clamped anywhere upstream. `toFixed` throws a
 * RangeError for d > 100. That's pathological model output (or an adversarial
 * prompt), not a normal ungrounded number, but it must never be allowed to
 * propagate out of runAgentTurn and crash the caller — the loop is designed to
 * gracefully regenerate-then-fall-back on ANY grounding failure. So any throw
 * here (this RangeError case included) is treated exactly like an ungrounded
 * result: zero tokens judged grounded, and the raw text kept for the retry
 * prompt.
 */
function safeCheckGrounding(
  text: string,
  allowed: number[]
): { ok: boolean; ungrounded: ReturnType<typeof extractNumbers> } {
  try {
    return checkGrounding(text, allowed);
  } catch {
    return { ok: false, ungrounded: extractNumbers(text) };
  }
}

export async function runAgentTurn(
  state: AgentState,
  userText: string,
  chat: ChatClient,
  tools: ToolDef[]
): Promise<AgentState> {
  const s: AgentState = { ...state, reply: '', violations: [], rounds: 0 };
  s.messages = [...state.messages, { role: 'user', content: userText }];

  // The user's own stated figures are legitimate to echo back.
  s.allowedNumbers = [...state.allowedNumbers, ...extractNumbers(userText).map((t) => t.value)];

  const schemas = tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    s.rounds = round + 1;
    const res = await chat(s.messages, schemas);

    if (res.toolCalls.length > 0) {
      s.messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls });
      for (const tc of res.toolCalls) {
        const tool = tools.find((t) => t.name === tc.function.name);
        let payload: string;
        if (!tool) {
          payload = JSON.stringify({ ok: false, error: `No such tool: ${tc.function.name}` });
        } else {
          let args: any = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = {};
          }
          let result;
          try {
            result = await tool.run(args, s.ctx);
          } catch (e: any) {
            result = { ok: false as const, error: e?.shortMessage || e?.message || String(e) };
          }
          if (result.ok) s.allowedNumbers.push(...result.numbers);
          payload = JSON.stringify(result.ok ? result.data : { error: result.error });
        }
        s.messages.push({ role: 'tool', tool_call_id: tc.id, content: payload });
      }
      continue;
    }

    const text = res.content ?? '';
    const check = safeCheckGrounding(text, s.allowedNumbers);
    if (check.ok) {
      s.messages.push({ role: 'assistant', content: text });
      s.reply = text;
      return s;
    }

    // Ungrounded (or grounding itself blew up on pathological output). Record
    // it, tell the model exactly which tokens it invented, and allow exactly
    // one correction before falling back.
    s.violations.push({
      attempt: s.violations.length + 1,
      tokens: check.ungrounded.map((t) => t.value),
      text,
    });
    if (s.violations.length >= 2) {
      s.reply = FALLBACK;
      return s;
    }
    s.messages.push({ role: 'assistant', content: text });
    s.messages.push({
      role: 'user',
      content:
        `These numbers did not come from any tool call: ${check.ungrounded.map((t) => t.raw).join(', ')}. ` +
        `Rewrite your answer using only numbers a tool returned, or call a tool to get them. Do not apologise.`,
    });
  }

  s.reply = FALLBACK;
  return s;
}
