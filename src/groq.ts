/**
 * Resilient HTTP transport for Groq API (OpenAI-compatible chat completions).
 * Handles transient gateway drops, rate limits (429, 500, 502, 503, 504, network errors)
 * with exponential backoff, request timeout, and clean error extraction (no raw HTML).
 */

export class GroqError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'GroqError';
    this.status = status;
  }
}

// Backward compatibility alias
export { GroqError as GonkaError };

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const DEFAULT_RETRY_DELAYS_MS = [500, 1500, 3000];
const DEFAULT_TIMEOUT_MS = 25_000;

export function isRetryableError(status: number | null, err: unknown): boolean {
  if (status !== null && RETRYABLE_STATUS_CODES.has(status)) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const name = err.name.toLowerCase();
    if (name.includes('abort') || name.includes('timeout')) return true;
    if (
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts a clean, concise, human-readable error string from an HTTP response body.
 * Guaranteed never to leak raw HTML tags (e.g. Cloudflare 502 error pages).
 */
export function cleanGroqError(status: number, statusText: string, rawBody: string): string {
  const trimmed = rawBody.trim();

  // Try JSON first (OpenAI / Groq-style error response)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const json = JSON.parse(trimmed);
      const msg = json.error?.message || json.error || json.message;
      if (typeof msg === 'string' && msg.trim()) {
        return `Groq ${status}: ${msg.trim()}`;
      }
    } catch {
      // not valid JSON, proceed to HTML/text parsing
    }
  }

  // Check for HTML response (e.g. Cloudflare 502 Bad Gateway)
  const isHtml =
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html') ||
    /<[a-z][\s\S]*>/i.test(trimmed);

  if (isHtml) {
    const titleMatch = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      let title = titleMatch[1].trim();
      title = title.replace(/^[^|]+\|\s*/, '').replace(/^\d+:\s*/, '').trim();
      return `Groq ${status} (${statusText || 'Bad Gateway'}): ${title}`;
    }
    return `Groq ${status} (${statusText || 'Bad Gateway'}): upstream gateway error. Please try again.`;
  }

  // Plain text response: strip tags, truncate if necessary
  const stripped = trimmed.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (stripped) {
    const truncated = stripped.length > 200 ? stripped.slice(0, 197) + '...' : stripped;
    return `Groq ${status} (${statusText || 'Error'}): ${truncated}`;
  }

  return `Groq ${status} (${statusText || 'Error'}): Upstream service temporarily unavailable.`;
}

// Backward compatibility alias
export const cleanGonkaError = cleanGroqError;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GroqRequestOptions {
  base: string;
  key: string;
  body: unknown;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  fetchFn?: typeof fetch;
}

// Backward compatibility alias
export type GonkaRequestOptions = GroqRequestOptions;

export async function callGroqChatCompletions(options: GroqRequestOptions): Promise<any> {
  const {
    base,
    key,
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    fetchFn = fetch,
  } = options;

  let lastError: Error | null = null;
  const totalAttempts = retryDelaysMs.length + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(retryDelaysMs[attempt - 1]);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetchFn(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const rawBody = await res.text().catch(() => '');
        const message = cleanGroqError(res.status, res.statusText, rawBody);
        const err = new GroqError(message, res.status);

        if (isRetryableError(res.status, err) && attempt < totalAttempts - 1) {
          lastError = err;
          continue;
        }
        throw err;
      }

      return await res.json();
    } catch (err: any) {
      if (err instanceof GroqError && !isRetryableError(err.status, err)) {
        throw err;
      }
      if (isRetryableError(err?.status ?? null, err) && attempt < totalAttempts - 1) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      if (err instanceof GroqError) throw err;
      throw new GroqError(
        `Groq network error: ${err?.message || String(err)}`,
        err?.status ?? 502
      );
    }
  }

  throw lastError ?? new GroqError('Groq request failed after retries', 502);
}

// Backward compatibility alias
export const callGonkaChatCompletions = callGroqChatCompletions;
