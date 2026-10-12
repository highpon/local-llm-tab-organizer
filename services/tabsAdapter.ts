import { NO_GROUP } from '../core/types';
import type { DedupePlan, GroupAdd, GroupInfo, GroupingPlan, Snapshot, TabInfo } from '../core/types';
import { revalidateClose } from '../core/planDedupe';
import { revalidateGroupAdd } from '../core/planGrouping';

export interface AppliedDedupe {
  closed: { tabId: number; windowId: number; url: string; cookieStoreId: string }[];
  skipped: number;
}
export interface AppliedGrouping {
  grouped: number[];
  skipped: number;
}

/** Duplicate-scope key: Firefox container id when present, else 'incognito' | 'default' (Chrome). */
export function cookieStoreKey(t: { cookieStoreId?: string; incognito?: boolean }): string {
  return t.cookieStoreId ?? (t.incognito ? 'incognito' : 'default');
}

async function getTab(tabId: number): Promise<TabInfo | undefined> {
  try {
    return toTabInfo(await browser.tabs.get(tabId));
  } catch {
    return undefined;
  }
}

function toTabInfo(t: Browser.tabs.Tab): TabInfo | undefined {
  if (t.id === undefined) return undefined;
  return {
    id: t.id,
    windowId: t.windowId ?? -1,
    url: t.url ?? '',
    title: t.title ?? '',
    pinned: t.pinned ?? false,
    active: t.active ?? false,
    audible: t.audible ?? false,
    lastAccessed: t.lastAccessed ?? 0,
    groupId: t.groupId ?? NO_GROUP,
    // cookieStoreId is Firefox-only, missing from the shared Tab type.
    cookieStoreId: cookieStoreKey(t as { cookieStoreId?: string; incognito?: boolean }),
  };
}

export async function snapshot(): Promise<Snapshot> {
  const tabs = (await browser.tabs.query({}))
    .map(toTabInfo)
    .filter((t): t is TabInfo => t !== undefined);
  const groupsSupported = typeof browser.tabGroups?.query === 'function';
  let groups: GroupInfo[] = [];
  if (groupsSupported) {
    groups = (await browser.tabGroups.query({})).map((g) => ({
      id: g.id,
      windowId: g.windowId,
      title: g.title ?? '',
    }));
  }
  return { tabs, groups, groupsSupported };
}

export async function applyDedupe(plan: DedupePlan): Promise<AppliedDedupe> {
  const result: AppliedDedupe = { closed: [], skipped: 0 };
  for (const entry of plan.closes) {
    try {
      const current = await getTab(entry.tabId);
      const keep = await getTab(entry.keepTabId);
      if (!revalidateClose(entry, current, keep)) {
        result.skipped++;
        continue;
      }
      await browser.tabs.remove(entry.tabId);
      result.closed.push({
        tabId: entry.tabId, windowId: entry.windowId, url: entry.url, cookieStoreId: entry.cookieStoreId,
      });
    } catch {
      result.skipped++;
    }
  }
  return result;
}

async function validTabIds(entries: GroupAdd[], result: AppliedGrouping): Promise<number[]> {
  const ids: number[] = [];
  for (const e of entries) {
    if (revalidateGroupAdd(e, await getTab(e.tabId))) ids.push(e.tabId);
    else result.skipped++;
  }
  return ids;
}

export async function applyGrouping(plan: GroupingPlan): Promise<AppliedGrouping> {
  const result: AppliedGrouping = { grouped: [], skipped: 0 };

  for (const add of plan.addToExisting) {
    const ids = await validTabIds(add.tabs, result);
    if (ids.length === 0) continue;
    try {
      await browser.tabs.group({ groupId: add.groupId, tabIds: ids as [number, ...number[]] });
      result.grouped.push(...ids);
    } catch {
      result.skipped += ids.length;
    }
  }

  for (const create of plan.createNew) {
    const ids = await validTabIds(create.tabs, result);
    if (ids.length === 0) continue;
    try {
      const groupId = await browser.tabs.group({
        tabIds: ids as [number, ...number[]],
        createProperties: { windowId: create.windowId },
      });
      result.grouped.push(...ids);
      try {
        await browser.tabGroups.update(groupId, { title: create.title });
      } catch {
        // the tabs are grouped; only the title failed
      }
    } catch {
      result.skipped += ids.length;
    }
  }

  return result;
}
