import type { DedupePlan, GroupingPlan } from '../core/types';

export type PendingKind = 'dedupe' | 'grouping';
export interface Pending { dedupe?: DedupePlan; grouping?: GroupingPlan; createdAt: number }

const PENDING_KEY = 'pending';

export async function loadPending(): Promise<Pending | null> {
  const stored = await browser.storage.local.get(PENDING_KEY);
  return (stored[PENDING_KEY] as Pending | undefined) ?? null;
}

export async function savePendingKind(
  kind: PendingKind, plan: DedupePlan | GroupingPlan, now: number,
): Promise<void> {
  const current = (await loadPending()) ?? { createdAt: now };
  await browser.storage.local.set({ [PENDING_KEY]: { ...current, [kind]: plan, createdAt: now } });
}

export async function discardPending(kind: PendingKind): Promise<void> {
  const current = await loadPending();
  if (!current) return;
  delete current[kind];
  if (current.dedupe || current.grouping) await browser.storage.local.set({ [PENDING_KEY]: current });
  else await browser.storage.local.remove(PENDING_KEY);
}
