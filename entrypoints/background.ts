import { runCycle, applyPending } from '../services/orchestrator';
import { deleteModels, ensureModels } from '../services/modelManager';
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
    case 'downloadModels':
      // Not awaited: the settings page follows progress through storage.
      ensureModels({ force: true }).catch(console.error);
      return undefined;
    case 'deleteModels':
      await deleteModels();
      return undefined;
  }
}

export default defineBackground(() => {
  // The idle detection interval is not persisted: set it on every event-page start.
  // Not awaited, so the listeners below are still registered synchronously.
  loadSettings()
    .then((s) => browser.idle.setDetectionInterval(s.schedule.idleSeconds))
    .catch(console.error);

  // All listeners are registered synchronously: the MV3 event page is restarted per event.
  browser.runtime.onInstalled.addListener(() => {
    setupSchedule().catch(console.error);
  });
  browser.runtime.onStartup.addListener(() => {
    // Tab ids do not survive a browser restart, so the previous session's undo record is useless.
    clearUndo().catch(console.error);
    setupSchedule().catch(console.error);
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_NAME) return;
    handleAlarm((sec) => browser.idle.queryState(sec), runCycle).catch(console.error);
  });

  browser.idle.onStateChanged.addListener((state) => {
    handleIdleChange(state, runCycle).catch(console.error);
  });

  browser.runtime.onMessage.addListener((message: unknown) => {
    const type = (message as { type?: unknown } | null)?.type;
    const known = ['runNow', 'applyPending', 'discardPending', 'undo', 'settingsChanged', 'downloadModels', 'deleteModels'];
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
