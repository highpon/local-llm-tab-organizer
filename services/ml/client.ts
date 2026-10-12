import { offscreenHost } from './offscreenTransport';
import type { MlRequest, MlResponse } from './protocol';

export interface MlClient {
  /** remote: false loads cached models only and fails instead of downloading. */
  load(onProgress?: (progress: number) => void, remote?: boolean): Promise<void>;
  /** Mean-pooled, L2-normalized embeddings, one per text. */
  embed(texts: string[]): Promise<number[][]>;
  /** One generated label per prompt. */
  topic(prompts: string[]): Promise<string[]>;
  terminate(): void;
}

export interface WorkerLike {
  postMessage(msg: MlRequest): void;
  onmessage: ((ev: { data: MlResponse }) => void) | null;
  onerror: ((ev: { message: string }) => void) | null;
  terminate(): void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

function spawnWorker(): WorkerLike {
  // Chrome's MV3 service worker cannot start Workers: go through the offscreen document.
  return import.meta.env.CHROME
    ? offscreenHost.spawn()
    : (new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
}

/** Promise wrapper around the ML worker. The worker is spawned on the first request. */
export function createMlClient(spawn: () => WorkerLike = spawnWorker): MlClient {
  let worker: WorkerLike | null = null;
  let nextId = 1;
  let onProgress: ((p: number) => void) | undefined;
  const pending = new Map<number, Pending>();

  const failAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };

  const ensureWorker = (): WorkerLike => {
    if (worker) return worker;
    const w = spawn();
    w.onmessage = (ev) => {
      const msg = ev.data;
      if ('type' in msg) {
        onProgress?.(msg.progress);
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
    w.onerror = (ev) => failAll(new Error(ev.message || 'ML worker error'));
    worker = w;
    return w;
  };

  type Body = MlRequest extends infer R ? R extends MlRequest ? Omit<R, 'id'> : never : never;
  const request = <T>(msg: Body): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ensureWorker().postMessage({ ...msg, id } as MlRequest);
    });

  return {
    async load(cb, remote = true) {
      onProgress = cb;
      try {
        await request<unknown>({ type: 'load', remote });
      } finally {
        onProgress = undefined;
      }
    },
    embed: (texts) => request<number[][]>({ type: 'embed', texts }),
    topic: (prompts) => request<string[]>({ type: 'topic', prompts }),
    terminate() {
      worker?.terminate();
      worker = null;
      failAll(new Error('ML worker terminated'));
    },
  };
}
