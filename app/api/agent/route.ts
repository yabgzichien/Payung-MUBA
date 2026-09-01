import type { NextRequest } from 'next/server';
import { newAgentState, runAgentTurn, type AgentState } from '@/src/agent';
import { groqChat } from '@/src/chat';
import { TOOLS } from '@/src/tools';
import { jsonResponse, requireJsonContentType, withErrorHandling, serverSigningAllowed } from '@/src/api-shared';

/**
 * Conversation state lives in memory, keyed by a client-supplied id. This is a
 * hackathon-scoped store: it is per-process and evaporates on redeploy, which
 * is acceptable because a dropped conversation costs the user nothing — no
 * funds move through this route. propose_execution returns a proposal that the
 * user still signs in their own wallet.
 */
const sessions = new Map<string, AgentState>();
const MAX_SESSIONS = 200;

/**
 * simulate_fill signs with the server's own burner wallet via writeClient() —
 * the same operation /api/simulate refuses on Vercel via serverSigningAllowed().
 * Computed once at module load since serverSigningAllowed() cannot change
 * during a process's lifetime; on a gated deployment simulate_fill is simply
 * never offered to the model, same as if the tool did not exist.
 */
const AGENT_TOOLS = serverSigningAllowed() ? TOOLS : TOOLS.filter((t) => t.readOnly);

export async function POST(req: NextRequest) {
  const bad = requireJsonContentType(req);
  if (bad) return bad;

  return withErrorHandling(async () => {
    const body = await req.json();
    const text = String(body?.text ?? '').trim();
    const sessionId = String(body?.sessionId ?? '');
    if (!text) return jsonResponse(400, { error: 'text is required' });
    if (!sessionId) return jsonResponse(400, { error: 'sessionId is required' });

    if (sessions.size > MAX_SESSIONS) sessions.clear();

    const prior = sessions.get(sessionId) ?? newAgentState();
    if (typeof body?.signerAddress === 'string') prior.ctx.signerAddress = body.signerAddress;
    const turnStart = prior.messages.length;

    const next = await runAgentTurn(prior, text, groqChat(), AGENT_TOOLS);
    sessions.set(sessionId, next);

    // The web UI's "Live offers" panel is the one place candidate numbers are
    // ever rendered from a tool's own wire data rather than model prose — see
    // grounding.ts's header comment. When find_protection ran this turn, hand
    // the resolved spec back so the client can drive that same panel instead
    // of relying on the model to describe candidates in chat.
    const calledFindProtection = next.messages
      .slice(turnStart)
      .some(
        (m: any) =>
          m.role === 'assistant' &&
          Array.isArray(m.tool_calls) &&
          m.tool_calls.some((tc: any) => tc.function?.name === 'find_protection')
      );
    const spec = calledFindProtection ? next.ctx.spec : null;

    // Surface the proposal when the agent called propose_execution this turn.
    // The tool result is stored as a role:'tool' message immediately after the
    // assistant message that contains the propose_execution tool_call. We scan
    // the tail of the messages to find it without re-traversing the entire
    // history — stopping as soon as we pass back into the prior turn's messages.
    let proposal: Record<string, unknown> | null = null;
    const msgs = next.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as any;
      if (m.role === 'tool') {
        const prev = msgs[i - 1] as any;
        if (
          prev?.role === 'assistant' &&
          Array.isArray(prev.tool_calls) &&
          prev.tool_calls.some((tc: any) => tc.function?.name === 'propose_execution')
        ) {
          try {
            const parsed = JSON.parse(m.content);
            if (parsed?.handoff === 'proposal') proposal = parsed;
          } catch {
            // malformed tool response — ignore
          }
          break;
        }
      }
      if (m.role === 'user' && i < msgs.length - 3) break;
    }

    return jsonResponse(200, {
      reply: next.reply,
      // Surfaced deliberately: a guard that visibly fires is stronger evidence
      // than one that never does.
      guardBlocked: next.violations.map((v) => v.tokens),
      rounds: next.rounds,
      // Non-null only when propose_execution was called this turn. The frontend
      // uses this to auto-navigate the user to the confirm step.
      proposal,
      // Non-null only when find_protection ran this turn. The frontend uses
      // this to sync the form and re-query /api/candidates for the same
      // deterministic card panel the manual form uses.
      spec,
    });
  });
}
