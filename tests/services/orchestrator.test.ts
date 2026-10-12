import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { NO_GROUP } from '../../core/types';
import type { CloseEntry, DedupePlan, ExistingGroup, GroupAdd, GroupingPlan, Snapshot, TabInfo } from '../../core/types';
import { applyPending, runCycle, type RunDeps } from '../../services/orchestrator';
import { discardPending, loadPending } from '../../services/pending';
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
    expect(deps.notify).toHaveBeenCalledWith('local-llm-tab-organizer-dedupe', 'Closed 1 duplicate tabs');
    expect(rec).toMatchObject({ closed: 1, grouped: 0, method: 'domain', skipped: false });
    expect(await listRuns()).toHaveLength(1);
  });

  it('re-takes the snapshot after merging duplicates', async () => {
    const deps = makeDeps();
    await runCycle('manual', deps);
    expect(deps.snapshot).toHaveBeenCalledTimes(2);
  });

  it('passes grouping candidates and existing groups to classify', async () => {
    const deps = makeDeps({
      snapshot: vi.fn(async () => snap({
        tabs: [tab(1, 'https://a.com/'), tab(2, 'https://b.com/', { pinned: true }), tab(3, 'https://c.com/', { groupId: 50 })],
        groups: [{ id: 50, windowId: 1, title: 'Existing' }],
      })),
    });
    await runCycle('manual', deps);
    const [tabs, existing, settings] = deps.classify.mock.calls[0]!;
    expect(tabs.map((t: TabInfo) => t.id)).toEqual([1]);
    expect(existing.map((g: ExistingGroup) => ({ title: g.title, ids: g.tabs.map((t) => t.id) })))
      .toEqual([{ title: 'Existing', ids: [3] }]);
    expect(settings.classifier).toBe('onDevice');
  });

  it('passes existing groups with all their tabs', async () => {
    const deps = makeDeps({
      snapshot: vi.fn(async () => snap({
        tabs: [tab(1, 'https://a.com/'), ...[5, 6, 7, 8].map((id) => tab(id, `https://g${id}.com/`, { groupId: 50 }))],
      })),
    });
    await runCycle('manual', deps);
    const existing: ExistingGroup[] = deps.classify.mock.calls[0]![1];
    expect(existing).toHaveLength(1);
    expect(existing[0]!.tabs.map((t) => t.id)).toEqual([5, 6, 7, 8]);
  });

  it('unnamed groups are not join targets', async () => {
    const deps = makeDeps({
      snapshot: vi.fn(async () => snap({
        tabs: [tab(1, 'https://a.com/'), tab(3, 'https://c.com/', { groupId: 52 })],
        groups: [{ id: 52, windowId: 1, title: '' }],
      })),
    });
    await runCycle('manual', deps);
    expect(deps.classify.mock.calls[0]![1]).toEqual([]);
  });

  it('same-titled groups in two windows are merged into one entry', async () => {
    const deps = makeDeps({
      snapshot: vi.fn(async () => snap({
        tabs: [tab(1, 'https://a.com/'), tab(3, 'https://c.com/', { groupId: 50 }),
          tab(4, 'https://d.com/', { groupId: 51, windowId: 2 })],
        groups: [{ id: 50, windowId: 1, title: 'Existing' }, { id: 51, windowId: 2, title: 'Existing' }],
      })),
    });
    await runCycle('manual', deps);
    const existing: ExistingGroup[] = deps.classify.mock.calls[0]![1];
    expect(existing).toHaveLength(1);
    expect(existing[0]!.tabs.map((t) => t.id)).toEqual([3, 4]);
  });

  it('records the classify error', async () => {
    const classify = vi.fn(async (tabs: TabInfo[]) => ({
      assignments: tabs.map((t) => ({ tabId: t.id, group: 'G' })), method: 'domain' as const, error: 'modelNotReady' as const,
    }));
    const rec = await runCycle('manual', makeDeps({ classify }));
    expect(rec.classifyError).toBe('modelNotReady');
  });

  it('LLM status only for the llm classifier', async () => {
    await browser.storage.local.set({ llmStatus: 'ok' });
    const classify = vi.fn(async (tabs: TabInfo[]) => ({
      assignments: tabs.map((t) => ({ tabId: t.id, group: 'G' })), method: 'domain' as const, error: 'inferenceFailed' as const,
    }));
    const deps = makeDeps({ classify });
    await runCycle('manual', deps);
    expect((await browser.storage.local.get('llmStatus')).llmStatus).toBeUndefined();
    expect(deps.notify.mock.calls.filter((c: unknown[]) => c[0] === 'local-llm-tab-organizer-llm')).toHaveLength(0);
  });

  it('classifies by domain when the classifier is domain', async () => {
    await setSettings({ classifier: 'domain', grouping: { mode: 'auto' } });
    const { classify: _unused, ...rest } = makeDeps();
    const rec = await runCycle('manual', rest);
    expect(rec.method).toBe('domain');
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
      'local-llm-tab-organizer-dedupe', 'Found 1 duplicate tabs. Review them from the toolbar button.');
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

  it('suggest mode does not re-notify an unchanged plan', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    const deps = makeDeps();
    await runCycle('alarm', deps);
    await runCycle('alarm', deps);
    const byId = (id: string) => deps.notify.mock.calls.filter((c: unknown[]) => c[0] === id);
    expect(byId('local-llm-tab-organizer-dedupe')).toHaveLength(1);
    expect(byId('local-llm-tab-organizer-grouping')).toHaveLength(1);
    expect((await loadPending())?.dedupe?.closes).toHaveLength(1);
  });

  it('suggest mode notifies again when the plan changes', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    const deps = makeDeps();
    await runCycle('alarm', deps);
    deps.snapshot.mockImplementation(async () => snap({
      tabs: [...snap().tabs, tab(5, 'https://c.com/q'), tab(6, 'https://c.com/q')],
    }));
    await runCycle('alarm', deps);
    const byId = (id: string) => deps.notify.mock.calls.filter((c: unknown[]) => c[0] === id);
    expect(byId('local-llm-tab-organizer-dedupe')).toHaveLength(2);
    expect(byId('local-llm-tab-organizer-grouping')).toHaveLength(2);
  });

  it('notifies about a 403 only on the transition into the error state', async () => {
    await setSettings({ classifier: 'llm' });
    await browser.storage.local.set({ llmStatus: 'ok' });
    const classify = vi.fn(async (tabs: TabInfo[]) => ({
      assignments: tabs.map((t) => ({ tabId: t.id, group: 'G' })), method: 'domain' as const, error: 'forbidden' as const,
    }));
    const deps = makeDeps({ classify });
    await runCycle('manual', deps);
    const llmCalls = () => deps.notify.mock.calls.filter((c: unknown[]) => c[0] === 'local-llm-tab-organizer-llm');
    expect(llmCalls()).toHaveLength(1);
    expect(llmCalls()[0]![1]).toContain('OLLAMA_ORIGINS=chrome-extension://*');
    expect((await browser.storage.local.get('llmStatus')).llmStatus).toBe('forbidden');
    await runCycle('manual', deps);
    expect(llmCalls()).toHaveLength(1);
  });

  it('uses the generic message for other LLM errors and resets status on success', async () => {
    await setSettings({ classifier: 'llm' });
    const err = vi.fn(async (tabs: TabInfo[]) => ({
      assignments: tabs.map((t) => ({ tabId: t.id, group: 'G' })), method: 'domain' as const, error: 'timeout' as const,
    }));
    const deps = makeDeps({ classify: err });
    await runCycle('manual', deps);
    expect(deps.notify).toHaveBeenCalledWith('local-llm-tab-organizer-llm', 'Cannot reach the LLM. Switched to grouping by domain.');
    await runCycle('manual', makeDeps());
    expect((await browser.storage.local.get('llmStatus')).llmStatus).toBe('ok');
  });

  it('pings the runtime every 20s while classify runs and stops afterwards', async () => {
    const ping = vi.spyOn(browser.runtime, 'getPlatformInfo').mockResolvedValue({} as never);
    vi.useFakeTimers();
    try {
      const deps = makeDeps({
        classify: vi.fn(async (tabs: TabInfo[]) => {
          await vi.advanceTimersByTimeAsync(45_000);
          return { assignments: tabs.map((t) => ({ tabId: t.id, group: 'G' })), method: 'llm' as const };
        }),
      });
      await runCycle('manual', deps);
      expect(ping).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      ping.mockRestore();
    }
  });

  it('does not touch llmStatus when the LLM is disabled', async () => {
    await runCycle('manual', makeDeps());
    expect((await browser.storage.local.get('llmStatus')).llmStatus).toBeUndefined();
  });

  it('removes a stale llmStatus once the LLM is disabled', async () => {
    await browser.storage.local.set({ llmStatus: 'timeout' });
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
    expect(await applyPending('grouping', deps)).toBe('applied');
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

  it('applyPending reports busy and applies nothing while a run holds the lock', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    await runCycle('manual', makeDeps());
    await browser.storage.session.set({ runLock: NOW - 1000 });
    const deps = makeDeps();
    expect(await applyPending('dedupe', deps)).toBe('busy');
    expect(deps.applyDedupe).not.toHaveBeenCalled();
    expect((await loadPending())?.dedupe).toBeDefined();
    expect((await browser.storage.session.get('runLock')).runLock).toBe(NOW - 1000);
  });

  it('applyPending reports busy while a run is in flight in this context', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    await runCycle('manual', makeDeps());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = makeDeps({
      classify: vi.fn(async (tabs: TabInfo[]) => {
        await gate;
        return { assignments: tabs.map((t) => ({ tabId: t.id, group: 'G' })), method: 'domain' as const };
      }),
    });
    const running = runCycle('manual', slow);
    await vi.waitFor(() => expect(slow.classify).toHaveBeenCalled());
    const deps = makeDeps();
    expect(await applyPending('grouping', deps)).toBe('busy');
    expect(deps.applyGrouping).not.toHaveBeenCalled();
    release();
    await running;
  });

  it('applyPending takes and releases the lock', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    await runCycle('manual', makeDeps());
    let lockDuringApply: unknown;
    const deps = makeDeps({
      applyDedupe: vi.fn(async () => {
        lockDuringApply = (await browser.storage.session.get('runLock')).runLock;
        return { closed: [], skipped: 1 };
      }),
    });
    await applyPending('dedupe', deps);
    expect(lockDuringApply).toBe(NOW);
    expect((await browser.storage.session.get('runLock')).runLock).toBeUndefined();
  });

  it('applyPending keeps a pending plan that was replaced while applying', async () => {
    await setSettings({ dedupe: { mode: 'suggest', acrossWindows: false } });
    await runCycle('manual', makeDeps());
    const newer: DedupePlan = { closes: [{
      tabId: 3, keepTabId: 4, windowId: 1, url: 'https://b.com/y', cookieStoreId: 'firefox-default', acrossWindows: false,
    }] };
    const deps = makeDeps({
      applyDedupe: vi.fn(async () => {
        const p = (await loadPending())!;
        await browser.storage.local.set({ pending: { ...p, dedupe: newer } });
        return { closed: [], skipped: 1 };
      }),
    });
    await applyPending('dedupe', deps);
    expect((await loadPending())?.dedupe).toEqual(newer);
  });

  it('applyPending with nothing stored does nothing', async () => {
    const deps = makeDeps();
    expect(await applyPending('dedupe', deps)).toBe('none');
    expect(deps.applyDedupe).not.toHaveBeenCalled();
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
