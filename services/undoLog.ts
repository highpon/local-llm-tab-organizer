import { normalizeUrl } from '../core/normalizeUrl';
import type { AppliedDedupe } from './tabsAdapter';

export interface UndoRecord {
  at: number;
  closed: AppliedDedupe['closed'];
  grouped: number[];
}

export interface UndoPorts {
  getRecentlyClosed(): Promise<{ sessionId: string; url: string }[]>;
  restore(sessionId: string): Promise<void>;
  create(url: string, windowId: number, cookieStoreId?: string): Promise<void>;
  ungroup(tabIds: number[]): Promise<void>;
}

const STORAGE_KEY = 'undo';
/** Tab ids are only meaningful for a while (and only within one browser session). */
const MAX_AGE_MS = 24 * 60 * 60_000;

export async function saveUndo(rec: UndoRecord): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: rec });
}

/** The last undo record, or null when there is none or it is older than 24 hours. */
export async function loadUndo(now: number = Date.now()): Promise<UndoRecord | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const rec = (stored[STORAGE_KEY] as UndoRecord | undefined) ?? null;
  return rec && now - rec.at <= MAX_AGE_MS ? rec : null;
}

export async function clearUndo(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEY);
}

function defaultPorts(): UndoPorts {
  return {
    async getRecentlyClosed() {
      const sessions = await browser.sessions.getRecentlyClosed({ maxResults: 25 });
      const out: { sessionId: string; url: string }[] = [];
      for (const s of sessions) {
        const t = s.tab;
        if (t?.sessionId && t.url) out.push({ sessionId: t.sessionId, url: t.url });
      }
      return out;
    },
    async restore(sessionId) {
      await browser.sessions.restore(sessionId);
    },
    async create(url, windowId, cookieStoreId) {
      // cookieStoreId (Firefox containers) is missing from the shared createProperties type.
      await browser.tabs.create({ url, windowId, ...(cookieStoreId ? { cookieStoreId } : {}) } as Browser.tabs.CreateProperties);
    },
    async ungroup(tabIds) {
      await browser.tabs.ungroup(tabIds as [number, ...number[]]);
    },
  };
}

let undoing = false; // same-context guard against a double click arriving mid-undo

export async function undoLast(
  ports: UndoPorts = defaultPorts(),
  now: number = Date.now(),
): Promise<{ restored: number; ungrouped: number }> {
  if (undoing) return { restored: 0, ungrouped: 0 };
  undoing = true;
  try {
    // Claim the record before touching any tab, so a second undo finds nothing.
    const rec = await loadUndo(now);
    await clearUndo();
    if (!rec) return { restored: 0, ungrouped: 0 };
    return { restored: await restoreClosed(rec.closed, ports), ungrouped: await ungroupEach(rec.grouped, ports) };
  } finally {
    undoing = false;
  }
}

async function restoreClosed(closed: UndoRecord['closed'], ports: UndoPorts): Promise<number> {
  if (closed.length === 0) return 0;
  let recent: { sessionId: string; url: string }[] = [];
  try {
    recent = await ports.getRecentlyClosed();
  } catch {
    recent = [];
  }
  const used = new Set<string>();
  let restored = 0;
  for (const c of closed) {
    const norm = normalizeUrl(c.url);
    const match = recent.find((r) => !used.has(r.sessionId) && (r.url === c.url || (norm !== null && normalizeUrl(r.url) === norm)));
    if (match) {
      used.add(match.sessionId);
      try {
        await ports.restore(match.sessionId);
        restored++;
        continue;
      } catch {
        // the session entry may have expired: recreate the tab instead
      }
    }
    try {
      await ports.create(c.url, c.windowId, c.cookieStoreId);
      restored++;
    } catch {
      // best effort: carry on with the remaining tabs
    }
  }
  return restored;
}

/** One call per tab, so a tab closed since the run does not stop the others. */
async function ungroupEach(tabIds: number[], ports: UndoPorts): Promise<number> {
  let ungrouped = 0;
  for (const id of tabIds) {
    try {
      await ports.ungroup([id]);
      ungrouped++;
    } catch {
      // tab closed since; nothing more to do
    }
  }
  return ungrouped;
}
