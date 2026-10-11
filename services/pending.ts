import type { DedupePlan, GroupingPlan } from '../core/types';

export type PendingKind = 'dedupe' | 'grouping';
export interface Pending { dedupe?: DedupePlan; grouping?: GroupingPlan; createdAt: number }

const PENDING_KEY = 'pending';

/**
 * Stable identity of a plan: which tab goes where. Two plans with the same signature
 * would do the same thing, whatever order or timestamp they were built with.
 */
export function planSignature(kind: PendingKind, plan: DedupePlan | GroupingPlan | undefined): string | null {
  if (!plan) return null;
  let parts: string[];
  if (kind === 'dedupe') {
    parts = (plan as DedupePlan).closes.map((c) => `${c.tabId}>${c.keepTabId}`);
  } else {
    const g = plan as GroupingPlan;
    parts = [
      ...g.addToExisting.flatMap((a) => a.tabs.map((t) => `${t.tabId}>g${a.groupId}`)),
      ...g.createNew.flatMap((c) => c.tabs.map((t) => `${t.tabId}>w${c.windowId}:${c.title.trim().toLowerCase()}`)),
    ];
  }
  return parts.sort().join('|');
}

export async function loadPending(): Promise<Pending | null> {
  const stored = await browser.storage.local.get(PENDING_KEY);
  return (stored[PENDING_KEY] as Pending | undefined) ?? null;
}

/** Stores the plan for `kind`; returns false when it is the same plan as the one already stored. */
export async function savePendingKind(
  kind: PendingKind, plan: DedupePlan | GroupingPlan, now: number,
): Promise<boolean> {
  const current = (await loadPending()) ?? { createdAt: now };
  const changed = planSignature(kind, current[kind]) !== planSignature(kind, plan);
  await browser.storage.local.set({ [PENDING_KEY]: { ...current, [kind]: plan, createdAt: now } });
  return changed;
}

export async function discardPending(kind: PendingKind): Promise<void> {
  const current = await loadPending();
  if (!current) return;
  delete current[kind];
  if (current.dedupe || current.grouping) await browser.storage.local.set({ [PENDING_KEY]: current });
  else await browser.storage.local.remove(PENDING_KEY);
}
