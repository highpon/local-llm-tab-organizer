import { NO_GROUP } from './types';
import type { Assignment, GroupAdd, GroupInfo, GroupingPlan, TabInfo } from './types';
import { normalizeUrl } from './normalizeUrl';

const nameKey = (s: string): string => s.trim().toLowerCase();

const isCandidate = (t: TabInfo): boolean =>
  t.groupId === NO_GROUP && !t.pinned && normalizeUrl(t.url) !== null;

export function groupingCandidates(tabs: TabInfo[]): TabInfo[] {
  return tabs.filter(isCandidate);
}

export function planGrouping(
  tabs: TabInfo[],
  groups: GroupInfo[],
  assignments: Assignment[],
): GroupingPlan {
  const candidates = new Map(groupingCandidates(tabs).map((t) => [t.id, t]));
  const sorted = [...assignments].sort((a, b) => a.tabId - b.tabId);

  const existing = new Map<number, GroupAdd[]>();
  const fresh = new Map<string, { windowId: number; title: string; tabs: GroupAdd[] }>();
  const seen = new Set<number>();

  for (const { tabId, group } of sorted) {
    const tab = candidates.get(tabId);
    const key = nameKey(group);
    if (!tab || !key || seen.has(tabId)) continue;
    seen.add(tabId);
    const entry: GroupAdd = { tabId, windowId: tab.windowId, url: tab.url };

    const target = groups.find((g) => g.windowId === tab.windowId && nameKey(g.title) === key);
    if (target) {
      const list = existing.get(target.id) ?? [];
      list.push(entry);
      existing.set(target.id, list);
      continue;
    }
    const bucketKey = `${tab.windowId}\u0000${key}`;
    const bucket = fresh.get(bucketKey) ?? { windowId: tab.windowId, title: group.trim(), tabs: [] };
    bucket.tabs.push(entry);
    fresh.set(bucketKey, bucket);
  }

  return {
    addToExisting: [...existing].map(([groupId, tabs]) => ({ groupId, tabs })),
    createNew: [...fresh.values()].filter((c) => c.tabs.length >= 2),
  };
}

export function revalidateGroupAdd(entry: GroupAdd, current: TabInfo | undefined): boolean {
  return (
    current !== undefined &&
    current.groupId === NO_GROUP &&
    current.windowId === entry.windowId &&
    !current.pinned
  );
}
