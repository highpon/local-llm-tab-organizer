import type { LlmErrorKind } from '../core/types';
import type { Settings } from './settings';

export class LlmError extends Error {
  constructor(public kind: LlmErrorKind, message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export type ChatMessage = { role: 'system' | 'user'; content: string };

const endpoint = (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/, '')}${path}`;

// Aborts after timeoutSeconds. Uses AbortController + setTimeout (rather than
// AbortSignal.timeout) so the timer is clearable and fake-timer friendly.
async function request(
  cfg: Settings['llm'], path: string, init: RequestInit, fetchFn: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, cfg.timeoutSeconds * 1000);
  try {
    let res: Response;
    try {
      res = await fetchFn(endpoint(cfg.baseUrl, path), { ...init, signal: controller.signal });
    } catch (e) {
      if (timedOut) throw new LlmError('timeout', `No response within ${cfg.timeoutSeconds}s`);
      throw new LlmError('unreachable', e instanceof Error ? e.message : String(e));
    }
    if (res.status === 403) throw new LlmError('forbidden', 'HTTP 403');
    if (!res.ok) throw new LlmError('http', `HTTP ${res.status}`);
    try {
      return await res.json();
    } catch (e) {
      if (timedOut) throw new LlmError('timeout', `No response within ${cfg.timeoutSeconds}s`);
      throw new LlmError('badResponse', 'Response is not valid JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function chatCompletion(
  cfg: Settings['llm'], messages: ChatMessage[], fetchFn: typeof fetch = fetch,
): Promise<string> {
  const data = (await request(cfg, '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0 }),
  }, fetchFn)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new LlmError('badResponse', 'Missing choices[0].message.content');
  return content;
}

export async function listModels(cfg: Settings['llm'], fetchFn: typeof fetch = fetch): Promise<string[]> {
  const data = (await request(cfg, '/models', { method: 'GET' }, fetchFn)) as { data?: { id?: unknown }[] } | null;
  if (!Array.isArray(data?.data)) throw new LlmError('badResponse', 'Missing data array');
  return data.data.map(m => m.id).filter((id): id is string => typeof id === 'string');
}
