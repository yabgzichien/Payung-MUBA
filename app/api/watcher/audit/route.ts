import type { NextRequest } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DIR } from '@/src/commitments';
import { jsonResponse, withErrorHandling } from '@/src/api-shared';

/** Tails the same agent-log.jsonl appendAudit() writes — CLI runs and GUI runs share one history. */
export async function GET(req: NextRequest) {
  return withErrorHandling(async () => {
    const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? 50)));
    const path = join(DEFAULT_DIR, 'agent-log.jsonl');
    if (!existsSync(path)) return jsonResponse(200, { entries: [] });

    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return jsonResponse(200, { entries });
  });
}
