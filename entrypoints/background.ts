import { runCycle, applyPending } from '../services/orchestrator';
import { discardPending } from '../services/pending';
import { ALARM_NAME, ensureAlarm, handleAlarm, handleIdleChange, type Message } from '../services/scheduler';
import { loadSettings } from '../services/settings';
import { clearUndo, undoLast } from '../services/undoLog';

async function setupSchedule(): Promise<void> {
  const settings = await loadSettings();
  await ensureAlarm(settings);
  browser.idle.setDetectionInterval(settings.schedule.idleSeconds);
}

async function handleMessage(msg: Message): Promise<unknown> {
  switch (msg.type) {
    case 'runNow':
      return runCycle('manual');
    case 'undo':
      return undoLast();
    case 'applyPending':
      return applyPending(msg.kind);
    case 'discardPending':
      await discardPending(msg.kind);
      return undefined;
    case 'settingsChanged':
      await setupSchedule();
      return undefined;
  }
}

export default defineBackground(() => {
  // All listeners are registered synchronously: the MV3 event page is restarted per event.
  browser.runtime.onInstalled.addListener(() => void setupSchedule());
  browser.runtime.onStartup.addListener(() => {
    // Tab ids do not survive a browser restart, so the previous session's undo record is useless.
    void clearUndo();
    void setupSchedule();
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    void handleAlarm((sec) => browser.idle.queryState(sec), runCycle);
  });

  browser.idle.onStateChanged.addListener((state) => {
    void handleIdleChange(state, runCycle);
  });

  browser.runtime.onMessage.addListener((message: unknown) => {
    const type = (message as { type?: unknown } | null)?.type;
    const known = ['runNow', 'applyPending', 'discardPending', 'undo', 'settingsChanged'];
    if (typeof type !== 'string' || !known.includes(type)) return undefined;
    return handleMessage(message as Message);
  });

  browser.notifications.onClicked.addListener(async () => {
    try {
      await browser.action.openPopup();
    } catch {
      await browser.runtime.openOptionsPage();
    }
  });
});
