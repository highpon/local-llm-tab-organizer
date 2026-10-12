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
  /** Number of files in the model cache; 0 when the browser evicted or the user cleared it. */
  cacheEntries: () => Promise<number>;
}

const RETRY_AFTER_MS = 60 * 60_000;
/** A download still marked as running after this long was cut off (e.g. the event page was unloaded). */
const STALE_DOWNLOAD_MS = 15 * 60_000;
const LOAD_FAILURES_KEY = 'modelLoadFailures';
/** Consecutive failures to load present models before they are treated as corrupt. */
const MAX_LOAD_FAILURES = 3;

function defaultDeps(): ModelDeps {
  return {
    client: () => createMlClient(),
    notify: async (message) => {
      await browser.notifications.create('local-llm-tab-organizer-model', {
        type: 'basic', title: 'Local LLM Tab Organizer', message, iconUrl: browser.runtime.getURL('/icon.svg'),
      });
    },
    now: Date.now,
    deleteCache: async () => {
      await caches.delete(MODEL_CACHE_NAME);
    },
    cacheEntries: async () =>
      (await caches.has(MODEL_CACHE_NAME)) ? (await (await caches.open(MODEL_CACHE_NAME)).keys()).length : 0,
  };
}

/** One-line, localized description of the model status for the popup and the settings page. */
export function modelStatusText(s: ModelStatus): string {
  switch (s.state) {
    case 'missing': return t('modelMissing');
    case 'downloading': return t('modelDownloading', Math.round((s.progress ?? 0) * 100));
    case 'ready': return t('modelReady');
    case 'error': return t('modelError', s.error ?? '');
  }
}

const saveStatus = (s: ModelStatus) => browser.storage.local.set({ [MODEL_STATUS_KEY]: s });

export async function loadModelStatus(): Promise<ModelStatus> {
  const stored = (await browser.storage.local.get(MODEL_STATUS_KEY))[MODEL_STATUS_KEY] as ModelStatus | undefined;
  return stored ?? { state: 'missing' };
}

/** The download running in this context, if any. */
let current: { client: MlClient; promise: Promise<void>; cancelled: boolean } | null = null;

/** Called with no download running in this context, so a 'downloading' status is left over. */
function mayStart(status: ModelStatus, force: boolean, now: number): boolean {
  const since = now - (status.lastAttemptAt ?? 0);
  switch (status.state) {
    case 'ready': return false;
    case 'missing': return true;
    case 'downloading': return force || since > STALE_DOWNLOAD_MS;
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
      }, true));
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

/**
 * Downloads run only in the background page and die with it, so a 'downloading' status found when
 * the background page starts is left over from an interrupted download.
 */
export async function resetInterruptedDownload(): Promise<void> {
  if (!current && (await loadModelStatus()).state === 'downloading') await saveStatus({ state: 'missing' });
}

/**
 * Ready models failed to load. Out of memory or a worker that would not start leave the files
 * usable, so they are deleted (and downloaded again by the next run) only when the cache is gone
 * or after MAX_LOAD_FAILURES failures in a row.
 */
export async function noteLoadFailure(deps: Partial<ModelDeps> = {}): Promise<void> {
  const d = { ...defaultDeps(), ...deps };
  const stored = (await browser.storage.local.get(LOAD_FAILURES_KEY))[LOAD_FAILURES_KEY];
  const failures = (typeof stored === 'number' ? stored : 0) + 1;
  if (failures >= MAX_LOAD_FAILURES || (await d.cacheEntries()) === 0) {
    await browser.storage.local.remove(LOAD_FAILURES_KEY);
    await invalidateModels(d);
  } else {
    await browser.storage.local.set({ [LOAD_FAILURES_KEY]: failures });
  }
}

export async function noteLoadSuccess(): Promise<void> {
  await browser.storage.local.remove(LOAD_FAILURES_KEY);
}

/** Deletes the downloaded models and marks them missing so the next run downloads again. */
export async function invalidateModels(deps: Partial<ModelDeps> = {}): Promise<void> {
  const d = { ...defaultDeps(), ...deps };
  await d.deleteCache();
  await saveStatus({ state: 'missing' });
}
