import { describe, it, expect } from 'vitest';
import { planDedupe, revalidateClose } from '../../core/planDedupe';
import type { TabInfo } from '../../core/types';

const U = 'https://example.com/a';
const tab = (p: Partial<TabInfo>): TabInfo => ({
  id: 1, windowId: 1, url: U, title: '', pinned: false, active: false,
  audible: false, groupId: -1, lastAccessed: 0, cookieStoreId: 'firefox-default', ...p,
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
  it('records whether the plan was across windows and the container', () => {
    const tabs = [tab({ id: 1, windowId: 1 }), tab({ id: 2, windowId: 2, lastAccessed: 5 })];
    expect(planDedupe(tabs, { acrossWindows: true }).closes[0]).toMatchObject({
      tabId: 1, keepTabId: 2, acrossWindows: true, cookieStoreId: 'firefox-default',
    });
    const same = [tab({ id: 1 }), tab({ id: 2, lastAccessed: 5 })];
    expect(planDedupe(same, { acrossWindows: false }).closes[0]).toMatchObject({ acrossWindows: false });
  });
  it.each([false, true])('never treats the same URL in different containers as duplicates (acrossWindows=%s)', (acrossWindows) => {
    const tabs = [
      tab({ id: 1, cookieStoreId: 'firefox-container-1' }),
      tab({ id: 2, cookieStoreId: 'firefox-container-2' }),
      tab({ id: 3, cookieStoreId: 'firefox-private' }),
      tab({ id: 4 }),
    ];
    expect(planDedupe(tabs, { acrossWindows }).closes).toEqual([]);
  });
});

describe('revalidateClose', () => {
  const entry = {
    tabId: 1, keepTabId: 2, windowId: 1, url: U, acrossWindows: false, cookieStoreId: 'firefox-default',
  };
  const keep = tab({ id: 2 });
  it('is true when unchanged', () => expect(revalidateClose(entry, tab({}), keep)).toBe(true));
  it('is false when gone/active/pinned/audible/url changed', () => {
    expect(revalidateClose(entry, undefined, keep)).toBe(false);
    expect(revalidateClose(entry, tab({ active: true }), keep)).toBe(false);
    expect(revalidateClose(entry, tab({ pinned: true }), keep)).toBe(false);
    expect(revalidateClose(entry, tab({ audible: true }), keep)).toBe(false);
    expect(revalidateClose(entry, tab({ url: 'https://example.com/b' }), keep)).toBe(false);
  });
  it('is false when the tab moved to another container', () => {
    expect(revalidateClose(entry, tab({ cookieStoreId: 'firefox-container-1' }), keep)).toBe(false);
  });
  it('is false when the keep tab is gone', () => {
    expect(revalidateClose(entry, tab({}), undefined)).toBe(false);
  });
  it('is false when the keep tab is the tab itself', () => {
    expect(revalidateClose(entry, tab({}), tab({ id: 1 }))).toBe(false);
  });
  it('is false when the keep tab navigated elsewhere', () => {
    expect(revalidateClose(entry, tab({}), tab({ id: 2, url: 'https://example.com/b' }))).toBe(false);
  });
  it('accepts a keep tab whose URL differs only by normalization', () => {
    expect(revalidateClose(entry, tab({}), tab({ id: 2, url: 'https://www.example.com/a/?utm_source=x' }))).toBe(true);
  });
  it('is false when the keep tab is in another container', () => {
    expect(revalidateClose(entry, tab({}), tab({ id: 2, cookieStoreId: 'firefox-container-1' }))).toBe(false);
  });
  it('is false when the keep tab moved to another window (per-window plan)', () => {
    expect(revalidateClose(entry, tab({}), tab({ id: 2, windowId: 9 }))).toBe(false);
  });
  it('is false when the tab itself moved to another window (per-window plan)', () => {
    expect(revalidateClose(entry, tab({ windowId: 9 }), keep)).toBe(false);
  });
  it('allows the keep tab in another window when the plan was across windows', () => {
    expect(revalidateClose({ ...entry, acrossWindows: true }, tab({}), tab({ id: 2, windowId: 9 }))).toBe(true);
  });
});
