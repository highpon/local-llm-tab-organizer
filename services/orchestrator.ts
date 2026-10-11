import { planDedupe } from '../core/planDedupe';
import { groupingCandidates, planGrouping } from '../core/planGrouping';
import type { DedupePlan, GroupingPlan, LlmErrorKind, Snapshot, TabInfo } from '../core/types';
import { classifyTabs, type ClassifyResult } from './llmClassifier';
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
  classify: (tabs: TabInfo[], groupNames: string[], cfg: Settings['llm']) => Promise<ClassifyResult>;
  notify: (id: string, message: string) => Promise<void>;
  now: () => number;
}

const LOCK_KEY = 'runLock';
const LOCK_TTL_MS = 5 * 60_000;
const LLM_STATUS_KEY = 'llmStatus';

const MSG_FORBIDDEN =
  'LLM に接続できません（403）。OLLAMA_ORIGINS=moz-extension://* を設定して Ollama を再起動してください';
const MSG_LLM_FALLBACK = 'LLM に接続できません。ドメイン単位の分類に切り替えました';

function defaultDeps(): RunDeps {
  return {
    snapshot: adapter.snapshot,
    applyDedupe: adapter.applyDedupe,
    applyGrouping: adapter.applyGrouping,
    classify: classifyTabs,
    notify: async (id, message) => {
      await browser.notifications.create(id, {
        type: 'basic', title: 'tab-tidy', message, iconUrl: browser.runtime.getURL('/icon.svg'),
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

async function updateLlmStatus(error: LlmErrorKind | undefined, d: RunDeps): Promise<void> {
  const prev = (await browser.storage.local.get(LLM_STATUS_KEY))[LLM_STATUS_KEY] as string | undefined;
  const next = error ?? 'ok';
  await browser.storage.local.set({ [LLM_STATUS_KEY]: next });
  if (next !== 'ok' && (prev === undefined || prev === 'ok')) {
    await d.notify('tab-tidy-llm', next === 'forbidden' ? MSG_FORBIDDEN : MSG_LLM_FALLBACK);
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
      let snap = await d.snapshot();

      if (settings.dedupe.mode !== 'off') {
        const plan = planDedupe(snap.tabs, { acrossWindows: settings.dedupe.acrossWindows });
        if (plan.closes.length > 0) {
          if (settings.dedupe.mode === 'auto') {
            closed.push(...(await d.applyDedupe(plan)).closed);
            snap = await d.snapshot();
            if (closed.length > 0) await d.notify('tab-tidy-dedupe', `重複タブを ${closed.length} 件閉じました`);
          } else {
            // Notify only when the suggestion changed, not on every interval.
            if (await savePendingKind('dedupe', plan, at)) {
              await d.notify('tab-tidy-dedupe',
                `重複タブが ${plan.closes.length} 件あります。ツールバーのボタンから確認できます`);
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
          const names = [...new Set(snap.groups.map((g) => g.title).filter((t) => t !== ''))];
          const result = await d.classify(candidates, names, settings.llm);
          record.method = result.method;
          if (settings.llm.enabled) await updateLlmStatus(result.error, d);
          plan = planGrouping(snap.tabs, snap.groups, result.assignments);
          n = countTabs(plan);
        }
        if (plan && n > 0) {
          if (settings.grouping.mode === 'auto') {
            grouped.push(...(await d.applyGrouping(plan)).grouped);
          } else {
            if (await savePendingKind('grouping', plan, at)) {
              await d.notify('tab-tidy-grouping',
                `${n} 枚のタブの分類案があります。ツールバーのボタンから確認できます`);
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
