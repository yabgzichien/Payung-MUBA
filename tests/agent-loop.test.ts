import { describe, it, expect } from 'vitest';
import { newAgentState, runAgentTurn, MAX_ROUNDS } from '../src/agent.js';
import type { ChatClient } from '../src/chat.js';
import type { ToolDef } from '../src/tools.js';

const fakeTools: ToolDef[] = [
  {
    name: 'get_spot',
    description: 'spot',
    readOnly: true,
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      return { ok: true, data: { price: 2410.5 }, numbers: [2410.5] };
    },
  },
];

/** Scripts a sequence of model responses, one per call. */
function scripted(responses: { content: string | null; toolCalls?: any[] }[]): ChatClient {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    return { content: r.content, toolCalls: (r.toolCalls ?? []) as any };
  };
}

const call = (name: string) => [{
  id: 't1', type: 'function' as const, function: { name, arguments: '{}' },
}];

describe('runAgentTurn', () => {
  it('runs a tool call and surfaces grounded prose', async () => {
    const chat = scripted([
      { content: null, toolCalls: call('get_spot') },
      { content: 'ETH is at $2,410.50 right now.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'what is eth at?', chat, fakeTools);
    expect(s.reply).toBe('ETH is at $2,410.50 right now.');
    expect(s.allowedNumbers).toContain(2410.5);
    expect(s.violations).toHaveLength(0);
  });

  it('adds the user’s own stated numbers to the allowlist', async () => {
    const chat = scripted([{ content: 'You said 1 ETH and a $2,300 floor.' }]);
    const s = await runAgentTurn(newAgentState(), 'I have 1 ETH and need $2,300', chat, fakeTools);
    expect(s.reply).toContain('2,300');
    expect(s.violations).toHaveLength(0);
  });

  it('retries once when prose contains an invented number', async () => {
    const chat = scripted([
      { content: null, toolCalls: call('get_spot') },
      { content: 'ETH is $2,410.50 and heading to $4,000.' },
      { content: 'ETH is $2,410.50.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'eth?', chat, fakeTools);
    expect(s.reply).toBe('ETH is $2,410.50.');
    expect(s.violations).toHaveLength(1);
    expect(s.violations[0].tokens).toContain(4000);
  });

  it('falls back deterministically when the retry is also ungrounded', async () => {
    const chat = scripted([
      { content: null, toolCalls: call('get_spot') },
      { content: 'ETH will hit $4,000.' },
      { content: 'Definitely $5,000.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'eth?', chat, fakeTools);
    expect(s.reply).not.toContain('4,000');
    expect(s.reply).not.toContain('5,000');
    expect(s.reply).toContain('could not');
    expect(s.violations).toHaveLength(2);
  });

  it('reports a tool error back to the model instead of throwing', async () => {
    const failing: ToolDef[] = [{
      ...fakeTools[0],
      async run() { return { ok: false, error: 'feed unavailable' }; },
    }];
    const chat = scripted([
      { content: null, toolCalls: call('get_spot') },
      { content: 'I could not read the price feed just now.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'eth?', chat, failing);
    expect(s.reply).toContain('could not read');
  });

  it('rejects an unknown tool name without crashing', async () => {
    const chat = scripted([
      { content: null, toolCalls: call('drop_tables') },
      { content: 'I do not have that ability.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'hi', chat, fakeTools);
    expect(s.reply).toContain('do not have');
  });

  it('stops at the round bound instead of looping forever', async () => {
    const chat = scripted([{ content: null, toolCalls: call('get_spot') }]);
    const s = await runAgentTurn(newAgentState(), 'loop', chat, fakeTools);
    expect(s.reply).toContain('could not');
    expect(s.rounds).toBe(MAX_ROUNDS);
  });

  it('treats a checkGrounding throw (pathological >100-fractional-digit number) as a violation, not a crash', async () => {
    // decimalsOf(tok.raw) is unbounded — it's read directly off the digits the
    // model wrote after the decimal point. `.toFixed(d)` throws a RangeError for
    // d > 100. This response is adversarial/degenerate model output, not a normal
    // ungrounded number: it must not propagate out of runAgentTurn and crash the
    // caller. The loop must catch it, record it as a violation exactly like an
    // ordinary ungrounded-prose case, and still return a valid AgentState.
    const pathological = '0.' + '1'.repeat(150);
    const chat = scripted([
      { content: null, toolCalls: call('get_spot') },
      { content: `ETH is at $${pathological} right now.` },
      { content: 'ETH is $2,410.50.' },
    ]);
    const s = await runAgentTurn(newAgentState(), 'eth?', chat, fakeTools);
    expect(s.reply).toBe('ETH is $2,410.50.');
    expect(s.violations).toHaveLength(1);
  });
});
