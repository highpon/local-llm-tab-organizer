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
  // First assignment per tab wins, in input order; that order also decides the title spelling.
  const chosen: { tab: TabInfo; group: string }[] = [];
  const titles = new Map<string, string>();
  const seen = new Set<number>();
  for (const { tabId, group } of assignments) {
    const tab = candidates.get(tabId);
    const key = nameKey(group);
    if (!tab || !key || seen.has(tabId)) continue;
    seen.add(tabId);
    chosen.push({ tab, group });
    const bucketKey = `${tab.windowId}\u0000${key}`;
    if (!titles.has(bucketKey)) titles.set(bucketKey, group.trim());
  }
  chosen.sort((a, b) => a.tab.id - b.tab.id);

  const existing = new Map<number, GroupAdd[]>();
  const fresh = new Map<string, { windowId: number; title: string; tabs: GroupAdd[] }>();

  for (const { tab, group } of chosen) {
    const key = nameKey(group);
    const entry: GroupAdd = { tabId: tab.id, windowId: tab.windowId, url: tab.url };

    const target = groups.find((g) => g.windowId === tab.windowId && nameKey(g.title) === key);
    if (target) {
      const list = existing.get(target.id) ?? [];
      list.push(entry);
      existing.set(target.id, list);
      continue;
    }
    const bucketKey = `${tab.windowId}\u0000${key}`;
    const bucket = fresh.get(bucketKey) ?? { windowId: tab.windowId, title: titles.get(bucketKey)!, tabs: [] };
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
    !current.pinned &&
    normalizeUrl(current.url) !== null &&
    normalizeUrl(current.url) === normalizeUrl(entry.url)
  );
}
