import type { WorkerLike } from './client';
import { ML_PORT, type PortLike, type RelayMessage } from './offscreenRelay';
import type { MlRequest, MlResponse } from './protocol';

export interface OffscreenDeps {
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  closeDocument(): Promise<void>;
  connect(): PortLike;
  delay(ms: number): Promise<void>;
}

export interface OffscreenHost {
  spawn(): WorkerLike;
  /** Closes an existing document when this host has no open Port. */
  closeIdle(): Promise<void>;
}

const MAX_CONNECTS = 5;
const RETRY_DELAY_MS = 200;
const CLOSED = 'ML offscreen document closed';

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function browserDeps(): OffscreenDeps {
  return {
    hasDocument: async () =>
      (await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0,
    createDocument: () =>
      browser.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Runs the on-device tab classifier in a Web Worker',
      }),
    closeDocument: () => browser.offscreen.closeDocument(),
    connect: () => browser.runtime.connect({ name: ML_PORT }) as unknown as PortLike,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * Background side of the Chrome ML transport. The service worker cannot start Workers, so each
 * worker-like talks over a Port to the relay in an offscreen document, which hosts the Worker.
 */
export function createOffscreenHost(deps: OffscreenDeps = browserDeps()): OffscreenHost {
  let openPorts = 0;
  let creating: Promise<void> | null = null;
  let closing: Promise<void> | null = null;

  const close = () => {
    if (closing && !creating) return; // Already closing and nothing can reopen it meanwhile.
    // Waits for an in-flight creation so the close does not race it.
    const p: Promise<void> = (creating ?? Promise.resolve())
      .catch(() => {})
      .then(() => deps.closeDocument())
      .catch(() => {}) // The document may already be gone.
      .finally(() => {
        if (closing === p) closing = null;
      });
    closing = p;
  };

  /** `wanted` is re-checked after a pending close: a caller terminated meanwhile must not create a document. */
  const ensureDocument = async (wanted: () => boolean): Promise<void> => {
    while (closing) await closing;
    if (!wanted()) return;
    if (!creating) {
      const p: Promise<void> = (async () => {
        if (!(await deps.hasDocument())) await deps.createDocument();
      })().finally(() => {
        if (creating === p) creating = null;
      });
      creating = p;
    }
    return creating;
  };

  const spawn = (): WorkerLike => {
    let state: 'idle' | 'connecting' | 'ready' | 'failed' | 'terminated' = 'idle';
    let counted = false;
    let port: PortLike | null = null;
    let failure = CLOSED;
    const queue: MlRequest[] = [];

    const release = () => {
      if (!counted) return;
      counted = false;
      openPorts--;
      if (openPorts === 0) close();
    };

    const fail = (message: string) => {
      state = 'failed';
      failure = message;
      port = null;
      queue.length = 0;
      release();
      worker.onerror?.({ message });
    };

    const attempt = async (n: number): Promise<void> => {
      try {
        await ensureDocument(() => state === 'connecting');
      } catch (e) {
        if (state === 'connecting') fail(errorMessage(e));
        return;
      }
      if (state !== 'connecting') return; // Terminated meanwhile.
      const p = deps.connect();
      port = p;
      p.onMessage.addListener((raw) => {
        if (port !== p) return;
        const msg = raw as RelayMessage;
        if (state === 'connecting') {
          if ('type' in msg && msg.type === 'relayReady') {
            state = 'ready';
            for (const m of queue.splice(0)) p.postMessage(m);
          }
          return;
        }
        if ('type' in msg && msg.type === 'workerError') {
          worker.onerror?.({ message: msg.message });
          return;
        }
        if ('type' in msg && msg.type === 'relayReady') return;
        worker.onmessage?.({ data: msg as MlResponse });
      });
      p.onDisconnect.addListener(() => {
        if (port !== p) return;
        port = null;
        if (state === 'ready') return fail(CLOSED);
        if (state !== 'connecting') return;
        if (n >= MAX_CONNECTS) return fail(CLOSED);
        void deps.delay(RETRY_DELAY_MS).then(() => {
          if (state === 'connecting') void attempt(n + 1);
        });
      });
    };

    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        if (state === 'ready') {
          port!.postMessage(msg);
        } else if (state === 'connecting') {
          queue.push(msg);
        } else if (state === 'idle') {
          state = 'connecting';
          queue.push(msg);
          counted = true;
          openPorts++;
          void attempt(1);
        } else if (state === 'failed') {
          // Fail the request instead of letting it hang.
          queueMicrotask(() => worker.onerror?.({ message: failure }));
        }
      },
      terminate() {
        if (state === 'terminated') return;
        state = 'terminated';
        queue.length = 0;
        const p = port;
        port = null;
        p?.disconnect();
        release();
      },
    };
    return worker;
  };

  return {
    spawn,
    async closeIdle() {
      if (openPorts > 0 || closing) return;
      if (!(await deps.hasDocument())) return;
      if (openPorts > 0 || closing) return;
      close();
      await closing;
    },
  };
}

let host: OffscreenHost | null = null;
const getHost = () => (host ??= createOffscreenHost());

/** Browser-backed singleton; nothing touches `browser` until it is first used. */
export const offscreenHost: OffscreenHost = {
  spawn: () => getHost().spawn(),
  closeIdle: () => getHost().closeIdle(),
};
