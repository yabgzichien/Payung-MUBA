import { describe, it, expect, vi } from 'vitest';
import {
  GonkaError,
  cleanGonkaError,
  isRetryableError,
  callGonkaChatCompletions,
} from '../src/gonka.js';

describe('cleanGonkaError', () => {
  it('extracts OpenAI-compatible JSON error message', () => {
    const raw = JSON.stringify({ error: { message: 'Invalid API key provided' } });
    const msg = cleanGonkaError(401, 'Unauthorized', raw);
    expect(msg).toBe('Groq 401: Invalid API key provided');
  });

  it('sanitizes Cloudflare 502 HTML error page and extracts title', () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>gonkarouter.io | 502: Bad gateway</title></head>
<body><div id="cf-wrapper"><h1>Bad gateway</h1></div></body>
</html>`;
    const msg = cleanGonkaError(502, 'Bad Gateway', html);
    expect(msg).toBe('Groq 502 (Bad Gateway): Bad gateway');
    expect(msg).not.toContain('<');
    expect(msg).not.toContain('>');
  });

  it('sanitizes generic HTML error pages without title', () => {
    const html = '<div class="error"><p>Something went wrong on server</p></div>';
    const msg = cleanGonkaError(502, 'Bad Gateway', html);
    expect(msg).toContain('Groq 502');
    expect(msg).not.toContain('<');
    expect(msg).not.toContain('>');
  });

  it('sanitizes and truncates long plain text', () => {
    const text = 'A'.repeat(300);
    const msg = cleanGonkaError(500, 'Internal Server Error', text);
    expect(msg.length).toBeLessThan(250);
    expect(msg).toContain('...');
  });
});

describe('isRetryableError', () => {
  it('identifies retryable status codes', () => {
    expect(isRetryableError(502, null)).toBe(true);
    expect(isRetryableError(503, null)).toBe(true);
    expect(isRetryableError(504, null)).toBe(true);
    expect(isRetryableError(524, null)).toBe(true);
    expect(isRetryableError(429, null)).toBe(true);
    expect(isRetryableError(500, null)).toBe(true);
  });

  it('identifies non-retryable status codes', () => {
    expect(isRetryableError(400, null)).toBe(false);
    expect(isRetryableError(401, null)).toBe(false);
    expect(isRetryableError(403, null)).toBe(false);
    expect(isRetryableError(404, null)).toBe(false);
  });

  it('identifies retryable network errors', () => {
    expect(isRetryableError(null, new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableError(null, new Error('socket hang up'))).toBe(true);
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    expect(isRetryableError(null, abortErr)).toBe(true);
  });
});

describe('callGonkaChatCompletions', () => {
  it('returns parsed JSON on 200 OK', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
    });

    const res = await callGonkaChatCompletions({
      base: 'https://api.gonkarouter.io/v1',
      key: 'test-key',
      body: { model: 'test', messages: [] },
      fetchFn: mockFetch as any,
    });

    expect(res.choices[0].message.content).toBe('hello');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on transient 502 and succeeds on subsequent attempt', async () => {
    const cfHtml = '<!DOCTYPE html><title>gonkarouter.io | 502: Bad gateway</title>';
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => cfHtml,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'recovered' } }] }),
      });

    const res = await callGonkaChatCompletions({
      base: 'https://api.gonkarouter.io/v1',
      key: 'test-key',
      body: { model: 'test', messages: [] },
      retryDelaysMs: [1, 1], // fast in test
      fetchFn: mockFetch as any,
    });

    expect(res.choices[0].message.content).toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('fails fast without retry on 401 Unauthorized', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ error: { message: 'Invalid API key' } }),
    });

    await expect(
      callGonkaChatCompletions({
        base: 'https://api.gonkarouter.io/v1',
        key: 'bad-key',
        body: { model: 'test', messages: [] },
        retryDelaysMs: [1, 1],
        fetchFn: mockFetch as any,
      })
    ).rejects.toThrow('Groq 401: Invalid API key');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws clean GonkaError when all retries fail with 502', async () => {
    const cfHtml = '<!DOCTYPE html><title>gonkarouter.io | 502: Bad gateway</title><body>Bad gateway</body>';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => cfHtml,
    });

    let err: any;
    try {
      await callGonkaChatCompletions({
        base: 'https://api.gonkarouter.io/v1',
        key: 'test-key',
        body: { model: 'test', messages: [] },
        retryDelaysMs: [1, 1],
        fetchFn: mockFetch as any,
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(GonkaError);
    expect(err.status).toBe(502);
    expect(err.message).toBe('Groq 502 (Bad Gateway): Bad gateway');
    expect(err.message).not.toContain('<');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
