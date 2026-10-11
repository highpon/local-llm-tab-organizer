import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { MlClient } from '../../services/ml/client';
import {
  deleteModels, ensureModels, invalidateModels, loadModelStatus, MODEL_STATUS_KEY, modelStatusText, noteLoadFailure,
  noteLoadSuccess, resetInterruptedDownload, type ModelStatus,
} from '../../services/modelManager';

const NOW = 1_000_000_000_000;
const MIN = 60_000;

type Load = (onProgress?: (p: number) => void, remote?: boolean) => Promise<void>;

function fakeClient(load: Load) {
  return {
    load: vi.fn(load),
    embed: vi.fn(async () => [] as number[][]),
    topic: vi.fn(async () => [] as string[]),
    terminate: vi.fn(() => {}),
  } satisfies MlClient;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeDeps(load: Load) {
  const clients: ReturnType<typeof fakeClient>[] = [];
  const deps = {
    client: vi.fn(() => {
      const c = fakeClient(load);
      clients.push(c);
      return c;
    }),
    notify: vi.fn(async () => {}),
    now: vi.fn<() => number>(() => NOW),
    deleteCache: vi.fn(async () => {}),
    cacheEntries: vi.fn<() => Promise<number>>(async () => 12),
  };
  return { deps, clients };
}

const setStatus = (s: ModelStatus) => browser.storage.local.set({ [MODEL_STATUS_KEY]: s });

describe('modelManager', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.spyOn(browser.runtime, 'getPlatformInfo').mockResolvedValue({} as never);
  });

  it('defaults to missing', async () => {
    expect(await loadModelStatus()).toEqual({ state: 'missing' });
  });

  it('downloads from missing to ready', async () => {
    const d = deferred();
    const seen: ModelStatus[] = [];
    let onProgress: ((p: number) => void) | undefined;
    const { deps, clients } = makeDeps((cb) => { onProgress = cb; return d.promise; });
    const run = ensureModels({}, deps);
    await vi.waitFor(() => expect(onProgress).toBeDefined());
    seen.push(await loadModelStatus());
    onProgress!(0.5);
    await vi.waitFor(async () => expect((await loadModelStatus()).progress).toBe(0.5));
    d.resolve();
    await run;
    expect(seen[0]).toMatchObject({ state: 'downloading', lastAttemptAt: NOW });
    expect(await loadModelStatus()).toMatchObject({ state: 'ready' });
    expect(clients[0]!.terminate).toHaveBeenCalled();
  });

  it('concurrent calls share one download', async () => {
    const d = deferred();
    const { deps } = makeDeps(() => d.promise);
    const a = ensureModels({}, deps);
    const b = ensureModels({}, deps);
    d.resolve();
    await Promise.all([a, b]);
    expect(deps.client).toHaveBeenCalledTimes(1);
  });

  it('failure sets error and notifies once', async () => {
    const { deps } = makeDeps(async () => { throw new Error('offline'); });
    await ensureModels({}, deps);
    expect(await loadModelStatus()).toMatchObject({ state: 'error', error: 'offline', lastAttemptAt: NOW });
    expect(deps.notify).toHaveBeenCalledTimes(1);
    deps.now.mockReturnValue(NOW + 61 * MIN);
    await ensureModels({}, deps);
    expect(deps.client).toHaveBeenCalledTimes(2);
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it('waits an hour before retrying after an error', async () => {
    await setStatus({ state: 'error', error: 'x', lastAttemptAt: NOW - 59 * MIN });
    const { deps } = makeDeps(async () => {});
    await ensureModels({}, deps);
    expect(deps.client).not.toHaveBeenCalled();
    deps.now.mockReturnValue(NOW + 2 * MIN);
    await ensureModels({}, deps);
    expect(deps.client).toHaveBeenCalledTimes(1);
  });

  it('force skips the back-off', async () => {
    await setStatus({ state: 'error', error: 'x', lastAttemptAt: NOW - MIN });
    const { deps } = makeDeps(async () => {});
    await ensureModels({ force: true }, deps);
    expect(deps.client).toHaveBeenCalledTimes(1);
    expect(await loadModelStatus()).toMatchObject({ state: 'ready' });
  });

  it('ready is left alone', async () => {
    await setStatus({ state: 'ready' });
    const { deps } = makeDeps(async () => {});
    await ensureModels({ force: true }, deps);
    expect(deps.client).not.toHaveBeenCalled();
  });

  it('stale downloading status is restarted', async () => {
    await setStatus({ state: 'downloading', progress: 0.3, lastAttemptAt: NOW - 14 * MIN });
    const { deps } = makeDeps(async () => {});
    await ensureModels({}, deps);
    expect(deps.client).not.toHaveBeenCalled();
    await setStatus({ state: 'downloading', progress: 0.3, lastAttemptAt: NOW - 16 * MIN });
    await ensureModels({}, deps);
    expect(deps.client).toHaveBeenCalledTimes(1);
  });

  it('delete during download ends missing', async () => {
    const d = deferred();
    const { deps, clients } = makeDeps(() => d.promise);
    const run = ensureModels({}, deps);
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    await deleteModels(deps);
    expect(clients[0]!.terminate).toHaveBeenCalled();
    expect(deps.deleteCache).toHaveBeenCalledTimes(1);
    d.resolve(); // a load that settles after the delete must not mark the models ready
    await run;
    expect(await loadModelStatus()).toEqual({ state: 'missing' });
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('force restarts a downloading status when no download runs here', async () => {
    await setStatus({ state: 'downloading', progress: 0.3, lastAttemptAt: NOW - MIN });
    const { deps } = makeDeps(async () => {});
    await ensureModels({ force: true }, deps);
    expect(deps.client).toHaveBeenCalledTimes(1);
    expect(await loadModelStatus()).toMatchObject({ state: 'ready' });
  });

  it('resetInterruptedDownload marks a leftover download missing', async () => {
    await setStatus({ state: 'downloading', progress: 0.3, lastAttemptAt: NOW - MIN });
    await resetInterruptedDownload();
    expect(await loadModelStatus()).toEqual({ state: 'missing' });
    await setStatus({ state: 'ready' });
    await resetInterruptedDownload();
    expect(await loadModelStatus()).toEqual({ state: 'ready' });
  });

  it('a load failure with the cache intact keeps the models', async () => {
    await setStatus({ state: 'ready' });
    const { deps } = makeDeps(async () => {});
    await noteLoadFailure(deps);
    await noteLoadFailure(deps);
    expect(deps.deleteCache).not.toHaveBeenCalled();
    expect(await loadModelStatus()).toEqual({ state: 'ready' });
  });

  it('a load failure with the cache gone invalidates at once', async () => {
    await setStatus({ state: 'ready' });
    const { deps } = makeDeps(async () => {});
    deps.cacheEntries.mockResolvedValue(0);
    await noteLoadFailure(deps);
    expect(deps.deleteCache).toHaveBeenCalledTimes(1);
    expect(await loadModelStatus()).toEqual({ state: 'missing' });
  });

  it('three load failures in a row invalidate; a success resets the count', async () => {
    await setStatus({ state: 'ready' });
    const { deps } = makeDeps(async () => {});
    await noteLoadFailure(deps);
    await noteLoadFailure(deps);
    await noteLoadSuccess();
    await noteLoadFailure(deps);
    await noteLoadFailure(deps);
    expect(deps.deleteCache).not.toHaveBeenCalled();
    await noteLoadFailure(deps);
    expect(deps.deleteCache).toHaveBeenCalledTimes(1);
    expect(await loadModelStatus()).toEqual({ state: 'missing' });
  });

  it('downloads with remote models allowed', async () => {
    const { deps, clients } = makeDeps(async () => {});
    await ensureModels({}, deps);
    expect(clients[0]!.load.mock.calls[0]![1]).toBe(true);
  });

  it('invalidateModels deletes the cache and sets missing', async () => {
    await setStatus({ state: 'ready' });
    const { deps } = makeDeps(async () => {});
    await invalidateModels(deps);
    expect(deps.deleteCache).toHaveBeenCalledTimes(1);
    expect(await loadModelStatus()).toEqual({ state: 'missing' });
  });

  it('describes each state', () => {
    expect(modelStatusText({ state: 'missing' })).toBe('Model: not downloaded yet (downloads on the next run)');
    expect(modelStatusText({ state: 'downloading', progress: 0.426 })).toBe('Model: downloading… 43%');
    expect(modelStatusText({ state: 'downloading' })).toBe('Model: downloading… 0%');
    expect(modelStatusText({ state: 'ready' })).toBe('Model: ready');
    expect(modelStatusText({ state: 'error', error: 'offline' })).toBe('Model: download failed (offline)');
  });
});
