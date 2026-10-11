import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { NO_GROUP } from '../../core/types';
import type { CloseEntry, DedupePlan, GroupAdd, GroupingPlan, Snapshot, TabInfo } from '../../core/types';
import {
  applyPending, discardPending, loadPending, runCycle, type RunDeps,
} from '../../services/orchestrator';
import { listRuns } from '../../services/runHistory';
import { saveSettings, DEFAULT_SETTINGS, type Settings } from '../../services/settings';
import { loadUndo } from '../../services/undoLog';

const NOW = Date.now();

const tab = (id: number, url: string, over: Partial<TabInfo> = {}): TabInfo => ({
  id, windowId: 1, url, title: `t${id}`, pinned: false, active: false, audible: false,
  lastAccessed: id, groupId: NO_GROUP, cookieStoreId: 'firefox-default', ...over,
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  tabs: [
    tab(1, 'https://a.com/x'), tab(2, 'https://a.com/x'),
    tab(3, 'https://b.com/y'), tab(4, 'https://b.com/z'),
  ],
  groups: [{ id: 50, windowId: 1, title: 'Existing' }],
  groupsSupported: true,
  ...over,
});

type Mocked = { [K in keyof RunDeps]: RunDeps[K] & ReturnType<typeof vi.fn> };

function makeDeps(over: Partial<RunDeps> = {}): Mocked {
  const deps = {
    snapshot: vi.fn(async () => snap()),
    applyDedupe: vi.fn(async (p: DedupePlan) => ({
      closed: p.closes.map((c: CloseEntry) => ({
        tabId: c.tabId, windowId: c.windowId, url: c.url, cookieStoreId: c.cookieStoreId,
      })), skipped: 0,
    })),
    applyGrouping: vi.fn(async (p: GroupingPlan) => ({
      grouped: [...p.addToExisting, ...p.createNew].flatMap((g) => g.tabs.map((t: GroupAdd) => t.tabId)), skipped: 0,
    })),
    classify: vi.fn(async (tabs: TabInfo[]) => ({
      assignments: tabs.map((t) => ({ tabId: t.id, group: 'G' })), method: 'domain' as const,
    })),
    notify: vi.fn(async () => {}),
    now: vi.fn(() => NOW),
    ...over,
  } as Mocked;
  return deps;
}

async function setSettings(patch: Partial<Settings>) {
  await saveSettings({ ...DEFAULT_SETTINGS, ...patch });
}

describe('runCycle', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('defaults: auto dedupe, suggest grouping', async () => {
    const deps = makeDeps();
    const rec = await runCycle('manual', deps);
    expect(deps.applyDedupe).toHaveBeenCalledTimes(1);
    expect((await loadUndo())?.closed).toHaveLength(1);
    expect(deps.applyGrouping).not.toHaveBeenCalled();
    const pending = await loadPending();
    expect(pending?.grouping).toBeDefined();
    expect(pending?.dedupe).toBeUndefined();
    expect(deps.notify).toHaveBeenCalledTimes(2); // dedupe closed + grouping suggestion
    expect(deps.notify).toHaveBeenCalledWith('tab-tidy-dedupe', '重複タブを 1 件閉じました');
    expect(rec).toMatchObject({ closed: 1, grouped: 0, method: 'domain', skipped: false });
    expect(await listRuns()).toHaveLength(1);
  });

  it('re-takes the snapshot after merging duplicates', async () => {
    const deps = makeDeps();
    await runCycle('manual', deps);
    expect(deps.snapshot).toHaveBeenCalledTimes(2);
  });

  it('passes grouping candidates and existing group names to classify', async () => {
    const deps = makeDeps({
      snapshot: vi.fn(async () => snap({
        tabs: [tab(1, 'https://a.com/'), tab(2, 'https://b.com/', { pinned: true }), tab(3, 'https://c.com/', { groupId: 50 })],
        groups: [{ id: 50, windowId: 1, title: 'Existing' }, { id: 51, windowId: 2, title: 'Existing' }, { id: 52, windowId: 2, title: '' }],
      })),
    });
    await runCycle('manual', deps);
    const [tabs, names] = deps.classify.mock.calls[0]!;
    expect(tabs.map((t: TabInfo) => t.id)).toEqual([1]);
    expect(names).toEqual(['Existing']);
  });

  it('grouping auto applies and records grouped in undo', async () => {
    await setSettings({ dedupe: { mode: 'off', acrossWindows: false }, grouping: { mode: 'auto' } });
    const deps = makeDeps();
    const rec = await runCycle('alarm', deps);
    expect(deps.applyGrouping).toHaveBeenCalledTimes(1);
    expect((await loadUndo())?.grouped.length).toBeGreaterThan(0);
    expect(rec.grouped).toBeGreaterThan(0);
    expect(await loadPending()).toBeNull();
  });

  it('combines dedupe and grouping into one undo record', async () => {
    await setSettings({ grouping: { mode: 'auto' } });
    const deps = makeDeps();
    await runCycle('alarm', deps);
    const undo = await loadUndo();
    expect(undo?.closed).toHaveLength(1);
    expect(undo?.grouped.length).toBeGreaterThan(0);
  });

  it('dedupe suggest stores pending and classifies the un-merged snapshot', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    const deps = makeDeps();
    await runCycle('manual', deps);
    expect(deps.applyDedupe).not.toHaveBeenCalled();
    expect((await loadPending())?.dedupe?.closes).toHaveLength(1);
    expect(deps.snapshot).toHaveBeenCalledTimes(1);
    expect(deps.classify.mock.calls[0]![0]).toHaveLength(4);
    expect(deps.notify).toHaveBeenCalledWith(
      'tab-tidy-dedupe', '重複タブが 1 件あります。ツールバーのボタンから確認できます');
  });

  it('suggest of one kind keeps the other kind pending', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    await runCycle('manual', makeDeps());
    const first = await loadPending();
    expect(first?.dedupe && first.grouping).toBeTruthy();
    await setSettings({ dedupe: { mode: 'off', acrossWindows: false } });
    await runCycle('manual', makeDeps());
    expect((await loadPending())?.dedupe).toEqual(first?.dedupe);
  });

  it('mode off does neither plan nor apply', async () => {
    await setSettings({ dedupe: { mode: 'off', acrossWindows: false }, grouping: { mode: 'off' } });
    const deps = makeDeps();
    const rec = await runCycle('manual', deps);
    expect(deps.applyDedupe).not.toHaveBeenCalled();
    expect(deps.applyGrouping).not.toHaveBeenCalled();
    expect(deps.classify).not.toHaveBeenCalled();
    expect(await loadPending()).toBeNull();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(rec).toMatchObject({ closed: 0, grouped: 0, method: null });
  });

  it('does not classify when groups are unsupported', async () => {
    const deps = makeDeps({ snapshot: vi.fn(async () => snap({ groupsSupported: false })) });
    await runCycle('manual', deps);
    expect(deps.classify).not.toHaveBeenCalled();
  });

  it('empty plans save no pending and send no notification', async () => {
    const deps = makeDeps({
      snapshot: vi.fn(async () => snap({ tabs: [tab(1, 'chrome://x'), tab(2, 'about:blank')] })),
    });
    await runCycle('manual', deps);
    expect(deps.classify).not.toHaveBeenCalled();
    expect(await loadPending()).toBeNull();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('skips when a fresh lock exists', async () => {
    await browser.storage.session.set({ runLock: NOW - 60_000 });
    const deps = makeDeps();
    const rec = await runCycle('alarm', deps);
    expect(rec.skipped).toBe(true);
    expect(deps.snapshot).not.toHaveBeenCalled();
    expect((await browser.storage.session.get('runLock')).runLock).toBe(NOW - 60_000);
    expect((await listRuns())[0]!.skipped).toBe(true);
  });

  it('ignores a stale lock and releases it afterwards', async () => {
    await browser.storage.session.set({ runLock: NOW - 6 * 60_000 });
    const deps = makeDeps();
    const rec = await runCycle('alarm', deps);
    expect(rec.skipped).toBe(false);
    expect(deps.snapshot).toHaveBeenCalled();
    expect((await browser.storage.session.get('runLock')).runLock).toBeUndefined();
  });

  it('records an error, releases the lock, and does not rethrow', async () => {
    const deps = makeDeps({ classify: vi.fn(async () => { throw new Error('boom'); }) });
    const rec = await runCycle('alarm', deps);
    expect(rec.error).toBe('boom');
    expect((await browser.storage.session.get('runLock')).runLock).toBeUndefined();
    expect((await listRuns())[0]!.error).toBe('boom');
    // dedupe already closed a tab before classify failed: it must still be undoable and counted
    expect(rec.closed).toBe(1);
    expect((await loadUndo())?.closed).toHaveLength(1);
  });

  it('lets only one of two simultaneous runs execute', async () => {
    const deps = makeDeps();
    const recs = await Promise.all([runCycle('alarm', deps), runCycle('manual', deps)]);
    expect(recs.filter((r) => r.skipped)).toHaveLength(1);
    expect(deps.applyDedupe).toHaveBeenCalledTimes(1);
    expect((await browser.storage.session.get('runLock')).runLock).toBeUndefined();
    const again = await runCycle('manual', makeDeps());
    expect(again.skipped).toBe(false);
  });

  it('removes stale pending entries when the new plan is empty (suggest mode)', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    await runCycle('manual', makeDeps());
    expect((await loadPending())?.dedupe).toBeDefined();
    const clean = makeDeps({
      snapshot: vi.fn(async () => snap({ tabs: [tab(1, 'https://a.com/'), tab(2, 'https://b.com/', { groupId: 50 })] })),
      classify: vi.fn(async () => ({ assignments: [], method: 'domain' as const })),
    });
    await runCycle('manual', clean);
    expect(await loadPending()).toBeNull();
  });

  it('notifies about a 403 only on the transition into the error state', async () => {
    await setSettings({ llm: { ...DEFAULT_SETTINGS.llm, enabled: true } });
    await browser.storage.local.set({ llmStatus: 'ok' });
    const classify = vi.fn(async (tabs: TabInfo[]) => ({
      assignments: tabs.map((t) => ({ tabId: t.id, group: 'G' })), method: 'domain' as const, error: 'forbidden' as const,
    }));
    const deps = makeDeps({ classify });
    await runCycle('manual', deps);
    const llmCalls = () => deps.notify.mock.calls.filter((c: unknown[]) => c[0] === 'tab-tidy-llm');
    expect(llmCalls()).toHaveLength(1);
    expect(llmCalls()[0]![1]).toContain('OLLAMA_ORIGINS=moz-extension://*');
    expect((await browser.storage.local.get('llmStatus')).llmStatus).toBe('forbidden');
    await runCycle('manual', deps);
    expect(llmCalls()).toHaveLength(1);
  });

  it('uses the generic message for other LLM errors and resets status on success', async () => {
    await setSettings({ llm: { ...DEFAULT_SETTINGS.llm, enabled: true } });
    const err = vi.fn(async (tabs: TabInfo[]) => ({
      assignments: tabs.map((t) => ({ tabId: t.id, group: 'G' })), method: 'domain' as const, error: 'timeout' as const,
    }));
    const deps = makeDeps({ classify: err });
    await runCycle('manual', deps);
    expect(deps.notify).toHaveBeenCalledWith('tab-tidy-llm', 'LLM に接続できません。ドメイン単位の分類に切り替えました');
    await runCycle('manual', makeDeps());
    expect((await browser.storage.local.get('llmStatus')).llmStatus).toBe('ok');
  });

  it('does not touch llmStatus when the LLM is disabled', async () => {
    await runCycle('manual', makeDeps());
    expect((await browser.storage.local.get('llmStatus')).llmStatus).toBeUndefined();
  });
});

describe('pending', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('applyPending applies the stored plan, records undo, removes only that kind', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    await runCycle('manual', makeDeps());
    const deps = makeDeps();
    const stored = (await loadPending())!.grouping!;
    await applyPending('grouping', deps);
    expect(deps.applyGrouping).toHaveBeenCalledWith(stored);
    const pending = await loadPending();
    expect(pending?.grouping).toBeUndefined();
    expect(pending?.dedupe).toBeDefined();
    expect((await loadUndo())?.grouped.length).toBeGreaterThan(0);
    expect(await listRuns()).toHaveLength(1);
    await applyPending('dedupe', deps);
    expect(await loadPending()).toBeNull();
    expect((await loadUndo())?.closed).toHaveLength(1);
  });

  it('discardPending removes only the given kind', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    await runCycle('manual', makeDeps());
    expect((await loadPending())?.dedupe && (await loadPending())?.grouping).toBeTruthy();
    await discardPending('grouping');
    const pending = await loadPending();
    expect(pending?.dedupe).toBeDefined();
    expect(pending?.grouping).toBeUndefined();
    await discardPending('dedupe');
    expect(await loadPending()).toBeNull();
  });
});
