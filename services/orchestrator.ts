import { classifyByDomain } from '../core/classifyByDomain';
import { planDedupe } from '../core/planDedupe';
import { groupingCandidates, planGrouping } from '../core/planGrouping';
import type { ClassifyErrorKind, DedupePlan, ExistingGroup, GroupInfo, GroupingPlan, Snapshot, TabInfo } from '../core/types';
import { extensionOriginPattern, t } from './i18n';
import { whileKeepingAlive } from './keepAlive';
import { classifyTabs, type ClassifyResult } from './llmClassifier';
import { classifyOnDevice } from './onDeviceClassifier';
import { discardPending, loadPending, planSignature, savePendingKind, type PendingKind } from './pending';
import { appendRun, type RunRecord, type Trigger } from './runHistory';
import { loadSettings, type Settings } from './settings';
import * as adapter from './tabsAdapter';
import type { AppliedDedupe, AppliedGrouping } from './tabsAdapter';
import { saveUndo } from './undoLog';

export interface RunDeps {
  snapshot: () => Promise<Snapshot>;
  applyDedupe: (p: DedupePlan) => Promise<AppliedDedupe>;
  applyGrouping: (p: GroupingPlan) => Promise<AppliedGrouping>;
  classify: (tabs: TabInfo[], existing: ExistingGroup[], settings: Settings) => Promise<ClassifyResult>;
  notify: (id: string, message: string) => Promise<void>;
  now: () => number;
}

const LOCK_KEY = 'runLock';
const LOCK_TTL_MS = 5 * 60_000;
const LLM_STATUS_KEY = 'llmStatus';

async function classify(tabs: TabInfo[], existing: ExistingGroup[], settings: Settings): Promise<ClassifyResult> {
  switch (settings.classifier) {
    case 'llm':
      return classifyTabs(tabs, existing.map((g) => g.title), settings.llm);
    case 'onDevice':
      return classifyOnDevice(tabs, existing);
    case 'domain':
      return { assignments: classifyByDomain(tabs), method: 'domain' };
  }
}

/** Named groups as join targets, with their tabs; same-titled groups (other windows) are merged. */
function existingGroups(tabs: TabInfo[], groups: GroupInfo[]): ExistingGroup[] {
  const byTitle = new Map<string, ExistingGroup>();
  for (const g of groups) {
    if (g.title === '') continue;
    const entry = byTitle.get(g.title) ?? { title: g.title, tabs: [] };
    entry.tabs.push(...tabs.filter((t) => t.groupId === g.id));
    byTitle.set(g.title, entry);
  }
  return [...byTitle.values()];
}

function defaultDeps(): RunDeps {
  return {
    snapshot: adapter.snapshot,
    applyDedupe: adapter.applyDedupe,
    applyGrouping: adapter.applyGrouping,
    classify,
    notify: async (id, message) => {
      await browser.notifications.create(id, {
        type: 'basic', title: 'Local LLM Tab Organizer', message, iconUrl: browser.runtime.getURL('/icon-128.png'),
      });
    },
    now: Date.now,
  };
}

async function acquireLock(now: number): Promise<boolean> {
  const stored = await browser.storage.session.get(LOCK_KEY);
  const held = stored[LOCK_KEY];
  if (typeof held === 'number' && now - held < LOCK_TTL_MS) return false;
  await browser.storage.session.set({ [LOCK_KEY]: now });
  return true;
}

async function updateLlmStatus(error: ClassifyErrorKind | undefined, d: RunDeps): Promise<void> {
  const prev = (await browser.storage.local.get(LLM_STATUS_KEY))[LLM_STATUS_KEY] as string | undefined;
  const next = error ?? 'ok';
  await browser.storage.local.set({ [LLM_STATUS_KEY]: next });
  if (next !== 'ok' && (prev === undefined || prev === 'ok')) {
    await d.notify('local-llm-tab-organizer-llm', next === 'forbidden' ? t('notifyForbidden', extensionOriginPattern()) : t('notifyLlmFallback'));
  }
}

const countTabs = (p: GroupingPlan): number =>
  [...p.addToExisting, ...p.createNew].reduce((n, g) => n + g.tabs.length, 0);

let inFlight = false; // same-context guard; the storage lock covers restarts and expiry

export type ApplyPendingResult = 'applied' | 'busy' | 'none';

/**
 * Applies a stored suggestion under the same guard and lock as runCycle, so it never
 * races a run. Returns 'busy' (and applies nothing) while a run is in progress.
 */
export async function applyPending(
  kind: PendingKind, deps: Partial<RunDeps> = {},
): Promise<ApplyPendingResult> {
  const d = { ...defaultDeps(), ...deps };
  if (inFlight) return 'busy';
  inFlight = true;
  let ownsLock = false;
  try {
    const now = d.now();
    ownsLock = await acquireLock(now);
    if (!ownsLock) return 'busy';
    const plan = (await loadPending())?.[kind];
    if (!plan) return 'none';
    if (kind === 'dedupe') {
      const res = await d.applyDedupe(plan as DedupePlan);
      if (res.closed.length > 0) await saveUndo({ at: now, closed: res.closed, grouped: [] });
    } else {
      const res = await d.applyGrouping(plan as GroupingPlan);
      if (res.grouped.length > 0) await saveUndo({ at: now, closed: [], grouped: res.grouped });
    }
    // Remove the suggestion only if it is still the one just applied.
    const after = (await loadPending())?.[kind];
    if (planSignature(kind, after) === planSignature(kind, plan)) await discardPending(kind);
    return 'applied';
  } finally {
    if (ownsLock) await browser.storage.session.remove(LOCK_KEY);
    inFlight = false;
  }
}

export async function runCycle(trigger: Trigger, deps: Partial<RunDeps> = {}): Promise<RunRecord> {
  const d = { ...defaultDeps(), ...deps };
  const at = d.now();
  const record: RunRecord = { at, trigger, closed: 0, grouped: 0, method: null, skipped: false };

  if (inFlight) {
    record.skipped = true;
    await appendRun(record);
    return record;
  }
  inFlight = true;
  let ownsLock = false;
  const closed: AppliedDedupe['closed'] = [];
  const grouped: number[] = [];

  try {
    ownsLock = await acquireLock(at);
    if (!ownsLock) {
      record.skipped = true;
    } else {
      const settings = await loadSettings();
      // A status from when the LLM was on would be stale and misleading in the popup.
      if (settings.classifier !== 'llm') await browser.storage.local.remove(LLM_STATUS_KEY);
      let snap = await d.snapshot();

      if (settings.dedupe.mode !== 'off') {
        const plan = planDedupe(snap.tabs, { acrossWindows: settings.dedupe.acrossWindows });
        if (plan.closes.length > 0) {
          if (settings.dedupe.mode === 'auto') {
            closed.push(...(await d.applyDedupe(plan)).closed);
            snap = await d.snapshot();
            if (closed.length > 0) await d.notify('local-llm-tab-organizer-dedupe', t('notifyClosed', closed.length));
          } else {
            // Notify only when the suggestion changed, not on every interval.
            if (await savePendingKind('dedupe', plan, at)) {
              await d.notify('local-llm-tab-organizer-dedupe',
                t('notifyDedupeSuggest', plan.closes.length));
            }
          }
        } else if (settings.dedupe.mode === 'suggest') {
          await discardPending('dedupe');
        }
      }

      if (settings.grouping.mode !== 'off' && snap.groupsSupported) {
        const candidates = groupingCandidates(snap.tabs);
        let n = 0;
        let plan: GroupingPlan | undefined;
        if (candidates.length > 0) {
          const existing = existingGroups(snap.tabs, snap.groups);
          const result = await whileKeepingAlive(() => d.classify(candidates, existing, settings));
          record.method = result.method;
          if (result.error) record.classifyError = result.error;
          if (settings.classifier === 'llm') await updateLlmStatus(result.error, d);
          plan = planGrouping(snap.tabs, snap.groups, result.assignments);
          n = countTabs(plan);
        }
        if (plan && n > 0) {
          if (settings.grouping.mode === 'auto') {
            grouped.push(...(await d.applyGrouping(plan)).grouped);
          } else {
            if (await savePendingKind('grouping', plan, at)) {
              await d.notify('local-llm-tab-organizer-grouping',
                t('notifyGroupingSuggest', n));
            }
          }
        } else if (settings.grouping.mode === 'suggest') {
          await discardPending('grouping');
        }
      }
    }
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
  } finally {
    // Record whatever was really applied, even when a later step failed.
    record.closed = closed.length;
    record.grouped = grouped.length;
    try {
      if (closed.length > 0 || grouped.length > 0) await saveUndo({ at, closed, grouped });
    } catch (e) {
      record.error ??= e instanceof Error ? e.message : String(e);
    }
    try {
      if (ownsLock) await browser.storage.session.remove(LOCK_KEY);
    } catch (e) {
      record.error ??= e instanceof Error ? e.message : String(e);
    }
    inFlight = false;
  }
  await appendRun(record);
  return record;
}
