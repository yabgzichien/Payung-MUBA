import type { IncomingMessage, ServerResponse } from 'node:http';
import { route } from '../src/server.js';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await route(req, res);
  } catch (e: any) {
    if (!res.writableEnded) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e?.shortMessage || e?.message || String(e) }));
    }
  }
}
