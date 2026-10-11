import { describe, it, expect } from 'vitest';
import { planDedupe, revalidateClose } from '../../core/planDedupe';
import type { TabInfo } from '../../core/types';

const U = 'https://example.com/a';
const tab = (p: Partial<TabInfo>): TabInfo => ({
  id: 1, windowId: 1, url: U, title: '', pinned: false, active: false,
  audible: false, groupId: -1, lastAccessed: 0, ...p,
});

describe('planDedupe', () => {
  it('keeps the most recently accessed', () => {
    const plan = planDedupe([
      tab({ id: 1, lastAccessed: 10 }), tab({ id: 2, lastAccessed: 30 }), tab({ id: 3, lastAccessed: 20 }),
    ], { acrossWindows: false });
    expect(plan.closes.map((c) => c.tabId)).toEqual([1, 3]);
    expect(plan.closes.every((c) => c.keepTabId === 2)).toBe(true);
  });
  it('excludes pinned/active/audible/non-http', () => {
    expect(planDedupe([tab({ id: 1, pinned: true }), tab({ id: 2 })], { acrossWindows: false }).closes).toEqual([]);
    expect(planDedupe([tab({ id: 1, audible: true }), tab({ id: 2 })], { acrossWindows: false }).closes).toEqual([]);
    expect(planDedupe([tab({ id: 1, url: 'about:blank' }), tab({ id: 2, url: 'about:blank' })], { acrossWindows: false }).closes).toEqual([]);
  });
  it('excluded tab is neither kept nor closed', () => {
    const plan = planDedupe([
      tab({ id: 1, active: true, lastAccessed: 99 }), tab({ id: 2, lastAccessed: 10 }), tab({ id: 3, lastAccessed: 20 }),
    ], { acrossWindows: false });
    expect(plan.closes).toHaveLength(1);
    expect(plan.closes[0]).toMatchObject({ tabId: 2, keepTabId: 3 });
  });
  it('per-window by default', () => {
    const tabs = [tab({ id: 1, windowId: 1 }), tab({ id: 2, windowId: 2 })];
    expect(planDedupe(tabs, { acrossWindows: false }).closes).toEqual([]);
    expect(planDedupe(tabs, { acrossWindows: true }).closes).toHaveLength(1);
  });
});

describe('revalidateClose', () => {
  const entry = { tabId: 1, keepTabId: 2, windowId: 1, url: U };
  it('is true when unchanged', () => expect(revalidateClose(entry, tab({}))).toBe(true));
  it('is false when gone/active/pinned/audible/url changed', () => {
    expect(revalidateClose(entry, undefined)).toBe(false);
    expect(revalidateClose(entry, tab({ active: true }))).toBe(false);
    expect(revalidateClose(entry, tab({ pinned: true }))).toBe(false);
    expect(revalidateClose(entry, tab({ audible: true }))).toBe(false);
    expect(revalidateClose(entry, tab({ url: 'https://example.com/b' }))).toBe(false);
  });
});
