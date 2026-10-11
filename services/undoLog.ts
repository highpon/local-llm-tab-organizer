import type { AppliedDedupe } from './tabsAdapter';

export interface UndoRecord {
  at: number;
  closed: AppliedDedupe['closed'];
  grouped: number[];
}

export interface UndoPorts {
  getRecentlyClosed(): Promise<{ sessionId: string; url: string }[]>;
  restore(sessionId: string): Promise<void>;
  create(url: string, windowId: number): Promise<void>;
  ungroup(tabIds: number[]): Promise<void>;
}

const STORAGE_KEY = 'undo';

export async function saveUndo(rec: UndoRecord): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: rec });
}

export async function loadUndo(): Promise<UndoRecord | null> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as UndoRecord | undefined) ?? null;
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
    async create(url, windowId) {
      await browser.tabs.create({ url, windowId });
    },
    async ungroup(tabIds) {
      await browser.tabs.ungroup(tabIds as [number, ...number[]]);
    },
  };
}

export async function undoLast(
  ports: UndoPorts = defaultPorts(),
): Promise<{ restored: number; ungrouped: number }> {
  const rec = await loadUndo();
  if (!rec) return { restored: 0, ungrouped: 0 };

  let restored = 0;
  let ungrouped = 0;

  if (rec.closed.length > 0) {
    let recent: { sessionId: string; url: string }[] = [];
    try {
      recent = await ports.getRecentlyClosed();
    } catch {
      recent = [];
    }
    const used = new Set<string>();
    for (const c of rec.closed) {
      const match = recent.find((r) => r.url === c.url && !used.has(r.sessionId));
      try {
        if (match) {
          used.add(match.sessionId);
          await ports.restore(match.sessionId);
        } else {
          await ports.create(c.url, c.windowId);
        }
        restored++;
      } catch {
        // best effort: carry on with the remaining tabs
      }
    }
  }

  if (rec.grouped.length > 0) {
    try {
      await ports.ungroup(rec.grouped);
      ungrouped = rec.grouped.length;
    } catch {
      // tabs may have been closed since; nothing more to do
    }
  }

  await browser.storage.local.remove(STORAGE_KEY);
  return { restored, ungrouped };
}
