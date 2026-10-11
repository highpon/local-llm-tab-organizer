import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatCompletion, listModels, LlmError } from '../../services/llmClient';

const cfg = { enabled: true, baseUrl: 'http://localhost:11434/v1', model: 'm1', timeoutSeconds: 5 };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const msgs = [{ role: 'user' as const, content: 'hello' }];

afterEach(() => { vi.useRealTimers(); });

async function kindOf(p: Promise<unknown>) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(LlmError); return (e as LlmError).kind; }
  return undefined;
}

describe('chatCompletion', () => {
  it('posts to /chat/completions and returns the message content', async () => {
    const fetchFn = vi.fn(async () => json({ choices: [{ message: { content: 'hi' } }] }));
    expect(await chatCompletion(cfg, msgs, fetchFn as unknown as typeof fetch)).toBe('hi');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'm1', messages: msgs, temperature: 0 });
  });
  it('works when baseUrl ends with a slash', async () => {
    const fetchFn = vi.fn(async () => json({ choices: [{ message: { content: 'x' } }] }));
    await chatCompletion({ ...cfg, baseUrl: 'http://h/v1/' }, msgs, fetchFn as unknown as typeof fetch);
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe('http://h/v1/chat/completions');
  });
  it('maps a TypeError to unreachable', async () => {
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await kindOf(chatCompletion(cfg, msgs, f as unknown as typeof fetch))).toBe('unreachable');
  });
  it('maps 403 to forbidden and 500 to http', async () => {
    const f403 = vi.fn(async () => json({}, 403));
    const f500 = vi.fn(async () => json({}, 500));
    expect(await kindOf(chatCompletion(cfg, msgs, f403 as unknown as typeof fetch))).toBe('forbidden');
    expect(await kindOf(chatCompletion(cfg, msgs, f500 as unknown as typeof fetch))).toBe('http');
  });
  it('maps a 200 without choices (or non-JSON) to badResponse', async () => {
    const f = vi.fn(async () => json({ nope: 1 }));
    expect(await kindOf(chatCompletion(cfg, msgs, f as unknown as typeof fetch))).toBe('badResponse');
    const g = vi.fn(async () => new Response('not json', { status: 200 }));
    expect(await kindOf(chatCompletion(cfg, msgs, g as unknown as typeof fetch))).toBe('badResponse');
  });
  it('maps no response within timeoutSeconds to timeout', async () => {
    vi.useFakeTimers();
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(init.signal!.reason ?? new DOMException('aborted', 'AbortError')));
    }));
    const p = kindOf(chatCompletion(cfg, msgs, f as unknown as typeof fetch));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('listModels', () => {
  it('GETs /models and returns data[].id', async () => {
    const fetchFn = vi.fn(async () => json({ data: [{ id: 'a' }, { id: 'b' }] }));
    expect(await listModels(cfg, fetchFn as unknown as typeof fetch)).toEqual(['a', 'b']);
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe('http://localhost:11434/v1/models');
  });
  it('throws badResponse without data', async () => {
    const f = vi.fn(async () => json({}));
    expect(await kindOf(listModels(cfg, f as unknown as typeof fetch))).toBe('badResponse');
  });
});
