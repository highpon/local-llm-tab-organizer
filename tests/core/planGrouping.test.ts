import { describe, it, expect } from 'vitest';
import { groupingCandidates, planGrouping, revalidateGroupAdd } from '../../core/planGrouping';
import type { TabInfo, GroupInfo } from '../../core/types';

const tab = (id: number, over: Partial<TabInfo> = {}): TabInfo => ({
  id, windowId: 1, url: `https://example.com/${id}`, title: '', pinned: false,
  active: false, audible: false, lastAccessed: 0, groupId: -1, ...over,
});
const add = (id: number, windowId = 1) => ({ tabId: id, windowId, url: `https://example.com/${id}` });

describe('groupingCandidates', () => {
  it('excludes grouped, pinned and non-http tabs', () => {
    const tabs = [
      tab(1), tab(2, { groupId: 5 }), tab(3, { pinned: true }),
      tab(4, { url: 'about:blank' }), tab(5, { url: 'http://a.test/' }),
    ];
    expect(groupingCandidates(tabs).map((t) => t.id)).toEqual([1, 5]);
  });
});

describe('planGrouping', () => {
  it('adds a single tab to an existing group, ignoring case and whitespace', () => {
    const groups: GroupInfo[] = [{ id: 10, windowId: 1, title: 'Dev' }];
    const plan = planGrouping([tab(1)], groups, [{ tabId: 1, group: '  dev ' }]);
    expect(plan.addToExisting).toEqual([{ groupId: 10, tabs: [add(1)] }]);
    expect(plan.createNew).toEqual([]);
  });

  it('does not use a same-named group from another window', () => {
    const groups: GroupInfo[] = [{ id: 10, windowId: 2, title: 'Dev' }];
    const tabs = [tab(1), tab(2)];
    const plan = planGrouping(tabs, groups, [
      { tabId: 1, group: 'Dev' }, { tabId: 2, group: 'Dev' },
    ]);
    expect(plan.addToExisting).toEqual([]);
    expect(plan.createNew).toEqual([{ windowId: 1, title: 'Dev', tabs: [add(1), add(2)] }]);
  });

  it('creates a new group for 2+ tabs in one window using the first spelling in input order', () => {
    const plan = planGrouping([tab(1), tab(2)], [], [
      { tabId: 2, group: ' news' }, { tabId: 1, group: 'News' },
    ]);
    expect(plan.createNew).toEqual([{ windowId: 1, title: 'news', tabs: [add(1), add(2)] }]);
  });

  it('leaves a lone new-name tab alone, and counts per window', () => {
    const tabs = [tab(1), tab(2, { windowId: 2 })];
    const plan = planGrouping(tabs, [], [
      { tabId: 1, group: 'X' }, { tabId: 2, group: 'X' },
    ]);
    expect(plan).toEqual({ addToExisting: [], createNew: [] });
  });

  it('uses the first assignment when a tab is assigned twice', () => {
    const groups: GroupInfo[] = [{ id: 10, windowId: 1, title: 'A' }, { id: 11, windowId: 1, title: 'B' }];
    const plan = planGrouping([tab(1)], groups, [
      { tabId: 1, group: 'A' }, { tabId: 1, group: 'B' },
    ]);
    expect(plan.addToExisting).toEqual([{ groupId: 10, tabs: [add(1)] }]);
  });

  it('ignores empty group names', () => {
    const plan = planGrouping([tab(1), tab(2)], [], [
      { tabId: 1, group: '  ' }, { tabId: 2, group: '' },
    ]);
    expect(plan).toEqual({ addToExisting: [], createNew: [] });
  });

  it('ignores assignments for non-candidate tabs', () => {
    const tabs = [tab(1, { groupId: 3 }), tab(2, { pinned: true })];
    const groups: GroupInfo[] = [{ id: 3, windowId: 1, title: 'X' }];
    const plan = planGrouping(tabs, groups, [
      { tabId: 1, group: 'X' }, { tabId: 2, group: 'X' }, { tabId: 99, group: 'X' },
    ]);
    expect(plan).toEqual({ addToExisting: [], createNew: [] });
  });

  it('is deterministic regardless of assignment order', () => {
    const tabs = [tab(1), tab(2), tab(3), tab(4)];
    const a = [
      { tabId: 4, group: 'B' }, { tabId: 3, group: 'B' },
      { tabId: 2, group: 'A' }, { tabId: 1, group: 'A' },
    ];
    const plan = planGrouping(tabs, [], a);
    expect(plan.createNew.map((c) => [c.title, c.tabs.map((t) => t.tabId)])).toEqual([
      ['A', [1, 2]], ['B', [3, 4]],
    ]);
  });
});

describe('revalidateGroupAdd', () => {
  const entry = add(1);
  it('accepts an unchanged tab', () => {
    expect(revalidateGroupAdd(entry, tab(1))).toBe(true);
  });
  it('rejects gone, grouped, moved or pinned tabs', () => {
    expect(revalidateGroupAdd(entry, undefined)).toBe(false);
    expect(revalidateGroupAdd(entry, tab(1, { groupId: 4 }))).toBe(false);
    expect(revalidateGroupAdd(entry, tab(1, { windowId: 2 }))).toBe(false);
    expect(revalidateGroupAdd(entry, tab(1, { pinned: true }))).toBe(false);
  });
  it('rejects a tab whose URL changed or is no longer http(s)', () => {
    expect(revalidateGroupAdd(entry, tab(1, { url: 'https://other.test/' }))).toBe(false);
    expect(revalidateGroupAdd(entry, tab(1, { url: 'about:blank' }))).toBe(false);
  });
  it('accepts a URL differing only by tracking param or fragment', () => {
    expect(revalidateGroupAdd(entry, tab(1, { url: 'https://example.com/1?utm_source=x#top' }))).toBe(true);
  });
});
