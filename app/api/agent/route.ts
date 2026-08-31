import type { NextRequest } from 'next/server';
import { newAgentState, runAgentTurn, type AgentState } from '@/src/agent';
import { gonkaChat } from '@/src/chat';
import { TOOLS } from '@/src/tools';
import { jsonResponse, requireJsonContentType, withErrorHandling } from '@/src/api-shared';

/**
 * Conversation state lives in memory, keyed by a client-supplied id. This is a
 * hackathon-scoped store: it is per-process and evaporates on redeploy, which
 * is acceptable because a dropped conversation costs the user nothing — no
 * funds move through this route. propose_execution returns a proposal that the
 * user still signs in their own wallet.
 */
const sessions = new Map<string, AgentState>();
const MAX_SESSIONS = 200;

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

    const next = await runAgentTurn(prior, text, gonkaChat(), TOOLS);
    sessions.set(sessionId, next);

    return jsonResponse(200, {
      reply: next.reply,
      // Surfaced deliberately: a guard that visibly fires is stronger evidence
      // than one that never does.
      guardBlocked: next.violations.map((v) => v.tokens),
      rounds: next.rounds,
    });
  });
}
