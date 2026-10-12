import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { CloseEntry } from '../../core/types';
import { applyDedupe, cookieStoreKey, snapshot } from '../../services/tabsAdapter';

const U = 'https://example.com/a';
type FakeTab = { id: number; windowId: number; url: string; cookieStoreId?: string };

function installTabs(list: FakeTab[]) {
  const tabs = new Map(list.map((t) => [t.id, { pinned: false, active: false, audible: false, title: '', ...t }]));
  vi.spyOn(browser.tabs, 'get').mockImplementation((async (id: number) => {
    const t = tabs.get(id);
    if (!t) throw new Error(`Invalid tab ID: ${id}`);
    return t;
  }) as never);
  const remove = vi.spyOn(browser.tabs, 'remove').mockImplementation((async (id: number) => {
    tabs.delete(id);
  }) as never);
  return remove;
}

const entry = (over: Partial<CloseEntry> = {}): CloseEntry => ({
  tabId: 1, keepTabId: 2, windowId: 1, url: U, cookieStoreId: 'default', acrossWindows: false, ...over,
});

describe('applyDedupe', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('closes the duplicate when the keep tab is still there', async () => {
    const remove = installTabs([{ id: 1, windowId: 1, url: U }, { id: 2, windowId: 1, url: U }]);
    const res = await applyDedupe({ closes: [entry()] });
    expect(remove).toHaveBeenCalledWith(1);
    expect(res.closed).toEqual([{ tabId: 1, windowId: 1, url: U, cookieStoreId: 'default' }]);
  });

  it('skips when the keep tab was closed', async () => {
    const remove = installTabs([{ id: 1, windowId: 1, url: U }]);
    const res = await applyDedupe({ closes: [entry()] });
    expect(remove).not.toHaveBeenCalled();
    expect(res).toEqual({ closed: [], skipped: 1 });
  });

  it('skips when the keep tab navigated elsewhere', async () => {
    const remove = installTabs([{ id: 1, windowId: 1, url: U }, { id: 2, windowId: 1, url: 'https://example.com/b' }]);
    await applyDedupe({ closes: [entry()] });
    expect(remove).not.toHaveBeenCalled();
  });

  it('skips when the keep tab moved to another window (per-window plan)', async () => {
    const remove = installTabs([{ id: 1, windowId: 1, url: U }, { id: 2, windowId: 2, url: U }]);
    await applyDedupe({ closes: [entry()] });
    expect(remove).not.toHaveBeenCalled();
  });

  it('closes when the keep tab moved to another window and the plan was across windows', async () => {
    const remove = installTabs([{ id: 1, windowId: 1, url: U }, { id: 2, windowId: 2, url: U }]);
    await applyDedupe({ closes: [entry({ acrossWindows: true })] });
    expect(remove).toHaveBeenCalledWith(1);
  });

  it('does not close every copy when two stale entries point at each other', async () => {
    // e.g. an old suggestion: 1 keeps 2, and a newer view where 2 keeps 1
    const remove = installTabs([{ id: 1, windowId: 1, url: U }, { id: 2, windowId: 1, url: U }]);
    await applyDedupe({ closes: [entry(), entry({ tabId: 2, keepTabId: 1 })] });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('records the container of a closed tab and skips a container mismatch', async () => {
    const C = 'firefox-container-1';
    const remove = installTabs([
      { id: 1, windowId: 1, url: U, cookieStoreId: C }, { id: 2, windowId: 1, url: U, cookieStoreId: C },
      { id: 3, windowId: 1, url: U }, { id: 4, windowId: 1, url: U, cookieStoreId: C },
    ]);
    const res = await applyDedupe({ closes: [entry({ cookieStoreId: C }), entry({ tabId: 3, keepTabId: 4 })] });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(res.closed[0]!.cookieStoreId).toBe(C);
  });
});

describe('cookieStoreKey', () => {
  it('incognito and regular tabs get different keys', () => {
    expect(cookieStoreKey({ incognito: true })).toBe('incognito');
    expect(cookieStoreKey({ incognito: false })).toBe('default');
    expect(cookieStoreKey({})).toBe('default');
  });
  it('keeps the Firefox cookieStoreId when present', () => {
    expect(cookieStoreKey({ cookieStoreId: 'firefox-container-1', incognito: false })).toBe('firefox-container-1');
  });
  it('snapshot keys tabs without cookieStoreId by incognito', async () => {
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([
      { id: 1, windowId: 1, url: U, incognito: false },
      { id: 2, windowId: 2, url: U, incognito: true },
    ] as never);
    vi.spyOn(browser.tabGroups, 'query').mockResolvedValue([] as never);
    const s = await snapshot();
    expect(s.tabs.map((t) => t.cookieStoreId)).toEqual(['default', 'incognito']);
  });
});
