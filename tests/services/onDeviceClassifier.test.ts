import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_GROUP, type ExistingGroup, type TabInfo } from '../../core/types';
import { topicPrompt } from '../../core/nameCluster';
import type { MlClient } from '../../services/ml/client';
import type { ModelStatus } from '../../services/modelManager';
import { classifyOnDevice, type OnDeviceDeps } from '../../services/onDeviceClassifier';

const tab = (id: number, url: string, title: string): TabInfo => ({
  id, windowId: 1, url, title, pinned: false, active: false, audible: false,
  lastAccessed: id, groupId: NO_GROUP, cookieStoreId: 'firefox-default',
});

const DIM = 400;
/** Unit vector at `deg` degrees in the first plane: texts embedded at close angles are similar. */
const at = (deg: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[0] = Math.cos((deg * Math.PI) / 180);
  v[1] = Math.sin((deg * Math.PI) / 180);
  return v;
};
/** One-hot vectors on their own axes: orthogonal to each other and to `at` vectors. */
const oneHot = (k: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[2 + k] = 1;
  return v;
};

/** Embeds a text by the first keyword of `angles` it contains; unknown texts are mutually far apart. */
function fakeClient(angles: Record<string, number>, topic: (prompts: string[]) => Promise<string[]> = async (p) => p.map(() => 'Topic')) {
  let unknown = 0;
  const vecFor = (text: string): number[] => {
    const key = Object.keys(angles).find((k) => text.includes(k));
    if (key !== undefined) return at(angles[key]!);
    return oneHot(unknown++);
  };
  return {
    load: vi.fn(async () => {}),
    embed: vi.fn(async (texts: string[]) => texts.map(vecFor)),
    topic: vi.fn(topic),
    terminate: vi.fn(() => {}),
  } satisfies MlClient;
}

function deps(client: MlClient, status: ModelStatus = { state: 'ready' }) {
  return {
    client: vi.fn(() => client),
    status: vi.fn(async () => status),
    ensure: vi.fn(() => {}),
    invalidate: vi.fn(async () => {}),
    timeoutMs: 60_000,
  } satisfies OnDeviceDeps;
}

const groupOf = (r: { assignments: { tabId: number; group: string }[] }, id: number) =>
  r.assignments.find((a) => a.tabId === id)?.group;

afterEach(() => { vi.useRealTimers(); });

describe('classifyOnDevice', () => {
  it('not ready: domain fallback and download started', async () => {
    for (const state of ['missing', 'downloading'] as const) {
      const c = fakeClient({});
      const d = deps(c, { state });
      const r = await classifyOnDevice([tab(1, 'https://github.com/a', 'A')], [], d);
      expect(r).toEqual({ assignments: [{ tabId: 1, group: 'Github' }], method: 'domain', error: 'modelNotReady' });
      expect(d.ensure).toHaveBeenCalledTimes(1);
      expect(d.client).not.toHaveBeenCalled();
    }
  });

  it('error status: domain fallback reported as modelDownloadFailed', async () => {
    const d = deps(fakeClient({}), { state: 'error', error: 'offline' });
    const r = await classifyOnDevice([tab(1, 'https://github.com/a', 'A')], [], d);
    expect(r).toMatchObject({ method: 'domain', error: 'modelDownloadFailed' });
    expect(d.ensure).toHaveBeenCalledTimes(1);
  });

  it('joins an existing group', async () => {
    const c = fakeClient({ Dogs: 0, Puppy: 5 });
    const existing: ExistingGroup[] = [{ title: 'Pets', tabs: [tab(9, 'https://pets.example/a', 'Dogs care')] }];
    const r = await classifyOnDevice([tab(1, 'https://x.example/p', 'Puppy food')], existing, deps(c));
    expect(groupOf(r, 1)).toBe('Pets');
    expect(r.method).toBe('onDevice');
  });

  it('clusters and names with the topic model', async () => {
    const c = fakeClient({ 'Dog food': 0, 'Dog toys': 3 }, async (p) => p.map(() => 'Dogs'));
    const tabs = [tab(1, 'https://a.example/1', 'Dog food reviews'), tab(2, 'https://b.example/2', 'Dog toys guide')];
    const r = await classifyOnDevice(tabs, [], deps(c));
    expect(groupOf(r, 1)).toBe('Dogs');
    expect(groupOf(r, 2)).toBe('Dogs');
    const prompt = c.topic.mock.calls[0]![0][0]!;
    expect(prompt).toBe(topicPrompt(['dog', 'food', 'reviews'], ['Dog food reviews', 'Dog toys guide']));
  });

  it('Japanese cluster is named by keywords', async () => {
    const c = fakeClient({ 天気予報: 0, 天気図: 3 });
    const tabs = [tab(1, 'https://a.example/1', '東京の天気予報'), tab(2, 'https://b.example/2', '大阪の天気図')];
    const r = await classifyOnDevice(tabs, [], deps(c));
    expect(c.topic).not.toHaveBeenCalled();
    expect(groupOf(r, 1)).toBe(groupOf(r, 2));
    expect(groupOf(r, 1)).toContain('天気');
  });

  it('rejected label falls back to keywords', async () => {
    const c = fakeClient({ 'Dog food': 0, 'Dog toys': 3 }, async (p) => p.map(() => 'None'));
    const tabs = [tab(1, 'https://a.example/1', 'Dog food'), tab(2, 'https://b.example/2', 'Dog toys')];
    const r = await classifyOnDevice(tabs, [], deps(c));
    expect(groupOf(r, 1)).toBe('dog food');
  });

  it('cluster without keywords is named by domain', async () => {
    const c = fakeClient({ '・': 0, '!!': 3 });
    const tabs = [tab(1, 'https://www.nikkei.com/a', '・'), tab(2, 'https://www.nikkei.com/b', '!!')];
    const r = await classifyOnDevice(tabs, [], deps(c));
    expect(groupOf(r, 1)).toBe('Nikkei');
    expect(groupOf(r, 2)).toBe('Nikkei');
  });

  it('singletons use domain classification', async () => {
    const c = fakeClient({});
    const r = await classifyOnDevice([tab(1, 'https://github.com/a', 'Lonely')], [], deps(c));
    expect(r).toEqual({ assignments: [{ tabId: 1, group: 'Github' }], method: 'onDevice' });
  });

  it('over 300 tabs: the rest use domain', async () => {
    const c = fakeClient({});
    const tabs = Array.from({ length: 302 }, (_, i) => tab(i + 1, `https://site${i}.com/`, `T${i}`));
    const r = await classifyOnDevice(tabs, [], deps(c));
    expect(c.embed.mock.calls[0]![0]).toHaveLength(300);
    expect(groupOf(r, 302)).toBe('Site301');
    expect(r.method).toBe('mixed');
  });

  it('inference error: domain fallback', async () => {
    const c = fakeClient({});
    c.embed.mockRejectedValue(new Error('oom'));
    const d = deps(c);
    const r = await classifyOnDevice([tab(1, 'https://github.com/a', 'A')], [], d);
    expect(r).toEqual({ assignments: [{ tabId: 1, group: 'Github' }], method: 'domain', error: 'inferenceFailed' });
    expect(c.terminate).toHaveBeenCalled();
    expect(d.invalidate).not.toHaveBeenCalled();
  });

  it('load failure on ready models invalidates the cache', async () => {
    const c = fakeClient({});
    c.load.mockRejectedValue(new Error('corrupt'));
    const d = deps(c);
    const r = await classifyOnDevice([tab(1, 'https://github.com/a', 'A')], [], d);
    expect(r.error).toBe('inferenceFailed');
    expect(d.invalidate).toHaveBeenCalledTimes(1);
  });

  it('timeout: domain fallback', async () => {
    vi.useFakeTimers();
    const c = fakeClient({});
    c.embed.mockImplementation(() => new Promise(() => {}));
    const p = classifyOnDevice([tab(1, 'https://github.com/a', 'A')], [], deps(c));
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await p;
    expect(r).toMatchObject({ method: 'domain', error: 'inferenceFailed' });
    expect(c.terminate).toHaveBeenCalled();
  });

  it('the client is always terminated', async () => {
    const c = fakeClient({});
    await classifyOnDevice([tab(1, 'https://github.com/a', 'A')], [], deps(c));
    expect(c.terminate).toHaveBeenCalledTimes(1);
  });

  it('does nothing without tabs', async () => {
    const c = fakeClient({});
    const d = deps(c);
    expect(await classifyOnDevice([], [], d)).toEqual({ assignments: [], method: 'onDevice' });
    expect(d.client).not.toHaveBeenCalled();
  });
});
