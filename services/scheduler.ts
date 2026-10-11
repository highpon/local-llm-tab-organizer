import { loadSettings, type Settings } from './settings';
import type { Trigger } from './runHistory';

export const ALARM_NAME = 'tab-tidy-run';
const PENDING_KEY = 'runPending';

export type IdleState = 'active' | 'idle' | 'locked';

export type Message =
  | { type: 'runNow' }
  | { type: 'applyPending'; kind: 'dedupe' | 'grouping' }
  | { type: 'discardPending'; kind: 'dedupe' | 'grouping' }
  | { type: 'undo' }
  | { type: 'settingsChanged' }
  | { type: 'downloadModels' }
  | { type: 'deleteModels' };

/** Create the alarm only when it is missing or its period differs. */
export async function ensureAlarm(s: Settings): Promise<void> {
  const period = s.schedule.intervalMinutes;
  const existing = await browser.alarms.get(ALARM_NAME);
  if (existing && existing.periodInMinutes === period) return;
  await browser.alarms.create(ALARM_NAME, { periodInMinutes: period });
}

export async function handleAlarm(
  queryIdle: (sec: number) => Promise<IdleState>,
  run: (t: Trigger) => Promise<unknown>,
): Promise<void> {
  const { schedule } = await loadSettings();
  const state = await queryIdle(schedule.idleSeconds);
  if (state === 'idle' || state === 'locked') {
    // This run covers any run deferred earlier; drop the mark so idle does not run again.
    await browser.storage.session.remove(PENDING_KEY);
    await run('alarm');
  } else {
    await browser.storage.session.set({ [PENDING_KEY]: true });
  }
}

export async function handleIdleChange(
  state: IdleState,
  run: (t: Trigger) => Promise<unknown>,
): Promise<void> {
  if (state === 'active') return;
  const stored = await browser.storage.session.get(PENDING_KEY);
  if (!stored[PENDING_KEY]) return;
  // Clear first so a crash mid-run cannot make the pending mark loop forever.
  await browser.storage.session.remove(PENDING_KEY);
  await run('idle');
}
