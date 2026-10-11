import { normalizeUrl } from './normalizeUrl';
import type { CloseEntry, DedupePlan, TabInfo } from './types';

export function planDedupe(tabs: TabInfo[], opts: { acrossWindows: boolean }): DedupePlan {
  const groups = new Map<string, TabInfo[]>();
  for (const t of tabs) {
    if (t.pinned || t.active || t.audible) continue;
    const norm = normalizeUrl(t.url);
    if (norm === null) continue;
    const key = opts.acrossWindows ? norm : `${t.windowId}\n${norm}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }
  const closes: CloseEntry[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = list.reduce((a, b) => (b.lastAccessed > a.lastAccessed ? b : a));
    for (const t of list) {
      if (t === keep) continue;
      closes.push({ tabId: t.id, keepTabId: keep.id, windowId: t.windowId, url: t.url });
    }
  }
  closes.sort((a, b) => a.tabId - b.tabId);
  return { closes };
}

/** Re-check right before closing: tab still exists, is not pinned/active/audible, and URL is unchanged. */
export function revalidateClose(entry: CloseEntry, current: TabInfo | undefined): boolean {
  if (!current) return false;
  if (current.pinned || current.active || current.audible) return false;
  const norm = normalizeUrl(current.url);
  return norm !== null && norm === normalizeUrl(entry.url);
}
