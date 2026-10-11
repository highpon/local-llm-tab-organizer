import { normalizeUrl } from './normalizeUrl';
import type { CloseEntry, DedupePlan, TabInfo } from './types';

export function planDedupe(tabs: TabInfo[], opts: { acrossWindows: boolean }): DedupePlan {
  const groups = new Map<string, TabInfo[]>();
  for (const t of tabs) {
    if (t.pinned || t.active || t.audible) continue;
    const norm = normalizeUrl(t.url);
    if (norm === null) continue;
    // Tabs in different containers / private windows never count as duplicates.
    const scope = opts.acrossWindows ? t.cookieStoreId : `${t.cookieStoreId}\n${t.windowId}`;
    const key = `${scope}\n${norm}`;
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
      closes.push({
        tabId: t.id, keepTabId: keep.id, windowId: t.windowId, url: t.url,
        cookieStoreId: t.cookieStoreId, acrossWindows: opts.acrossWindows,
      });
    }
  }
  closes.sort((a, b) => a.tabId - b.tabId);
  return { closes };
}

/**
 * Re-check right before closing. The tab must still exist, not be pinned/active/audible,
 * and keep its URL, container and (per-window plan) window. The keep tab must still exist,
 * be a different tab, show the same URL in the same container, and (per-window plan) be in
 * the same window — otherwise closing could lose the last copy of the page.
 */
export function revalidateClose(
  entry: CloseEntry, current: TabInfo | undefined, keep: TabInfo | undefined,
): boolean {
  if (!current || !keep) return false;
  if (current.pinned || current.active || current.audible) return false;
  if (keep.id === current.id) return false;
  const norm = normalizeUrl(entry.url);
  if (norm === null) return false;
  for (const t of [current, keep]) {
    if (normalizeUrl(t.url) !== norm) return false;
    if (t.cookieStoreId !== entry.cookieStoreId) return false;
    if (!entry.acrossWindows && t.windowId !== entry.windowId) return false;
  }
  return true;
}
