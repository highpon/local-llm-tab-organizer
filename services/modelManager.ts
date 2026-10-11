import { t } from './i18n';
import { whileKeepingAlive } from './keepAlive';
import { createMlClient, type MlClient } from './ml/client';
import { MODEL_CACHE_NAME } from './ml/models';

export type ModelState = 'missing' | 'downloading' | 'ready' | 'error';
export interface ModelStatus { state: ModelState; progress?: number; error?: string; lastAttemptAt?: number }

export const MODEL_STATUS_KEY = 'modelStatus';

export interface ModelDeps {
  client: () => MlClient;
  notify: (message: string) => Promise<void>;
  now: () => number;
  deleteCache: () => Promise<void>;
}

const RETRY_AFTER_MS = 60 * 60_000;
/** A download still marked as running after this long was cut off (e.g. the event page was unloaded). */
const STALE_DOWNLOAD_MS = 15 * 60_000;

function defaultDeps(): ModelDeps {
  return {
    client: () => createMlClient(),
    notify: async (message) => {
      await browser.notifications.create('tab-tidy-model', {
        type: 'basic', title: 'tab-tidy', message, iconUrl: browser.runtime.getURL('/icon.svg'),
      });
    },
    now: Date.now,
    deleteCache: async () => {
      await caches.delete(MODEL_CACHE_NAME);
    },
  };
}

const saveStatus = (s: ModelStatus) => browser.storage.local.set({ [MODEL_STATUS_KEY]: s });

export async function loadModelStatus(): Promise<ModelStatus> {
  const stored = (await browser.storage.local.get(MODEL_STATUS_KEY))[MODEL_STATUS_KEY] as ModelStatus | undefined;
  return stored ?? { state: 'missing' };
}

/** The download running in this context, if any. */
let current: { client: MlClient; promise: Promise<void>; cancelled: boolean } | null = null;

function mayStart(status: ModelStatus, force: boolean, now: number): boolean {
  const since = now - (status.lastAttemptAt ?? 0);
  switch (status.state) {
    case 'ready': return false;
    case 'missing': return true;
    case 'downloading': return since > STALE_DOWNLOAD_MS;
    case 'error': return force || since >= RETRY_AFTER_MS;
  }
}

/**
 * Starts a download unless one is running, the models are ready, or the 1-hour back-off after a
 * failure applies (`force` skips the back-off). Resolves when the download ends; never rejects.
 */
export async function ensureModels(opts: { force?: boolean } = {}, deps: Partial<ModelDeps> = {}): Promise<void> {
  if (current) return current.promise;
  const d = { ...defaultDeps(), ...deps };
  const status = await loadModelStatus();
  if (current) return (current as { promise: Promise<void> }).promise; // started while we awaited
  const now = d.now();
  if (!mayStart(status, opts.force ?? false, now)) return;

  const client = d.client();
  const run = { client, cancelled: false, promise: Promise.resolve() };
  current = run;
  run.promise = (async () => {
    let lastPercent = -1;
    try {
      await saveStatus({ state: 'downloading', progress: 0, lastAttemptAt: now });
      await whileKeepingAlive(() => client.load((p) => {
        const percent = Math.floor(p * 100);
        if (percent === lastPercent || run.cancelled) return;
        lastPercent = percent;
        void saveStatus({ state: 'downloading', progress: p, lastAttemptAt: now });
      }));
      if (!run.cancelled) await saveStatus({ state: 'ready' });
    } catch (e) {
      if (run.cancelled) return;
      await saveStatus({ state: 'error', error: e instanceof Error ? e.message : String(e), lastAttemptAt: now });
      // Notify on the transition into the error state only.
      if (status.state !== 'error') await d.notify(t('notifyModelFailed')).catch(() => {});
    } finally {
      client.terminate();
      if (current === run) current = null;
    }
  })();
  return run.promise;
}

/** Stops a running download, deletes the downloaded files and marks the models missing. */
export async function deleteModels(deps: Partial<ModelDeps> = {}): Promise<void> {
  const d = { ...defaultDeps(), ...deps };
  if (current) {
    // Not awaited: a cancelled run writes no status, however late its load settles.
    current.cancelled = true;
    current.client.terminate();
    current = null;
  }
  await d.deleteCache();
  await saveStatus({ state: 'missing' });
}

/** Called when ready models fail to load (corrupt cache): delete them so the next run downloads again. */
export async function invalidateModels(deps: Partial<ModelDeps> = {}): Promise<void> {
  const d = { ...defaultDeps(), ...deps };
  await d.deleteCache();
  await saveStatus({ state: 'missing' });
}
