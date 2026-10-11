import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ALARM_NAME, ensureAlarm, handleAlarm, handleIdleChange } from '../../services/scheduler';
import { DEFAULT_SETTINGS } from '../../services/settings';

const settings = (intervalMinutes: number) => ({
  ...DEFAULT_SETTINGS,
  schedule: { ...DEFAULT_SETTINGS.schedule, intervalMinutes },
});

const runPending = async () => (await browser.storage.session.get('runPending')).runPending;

beforeEach(() => {
  fakeBrowser.reset();
});

describe('ensureAlarm', () => {
  it('creates the alarm when missing', async () => {
    await ensureAlarm(settings(30));
    const a = await browser.alarms.get(ALARM_NAME);
    expect(a?.periodInMinutes).toBe(30);
  });

  it('does not recreate an alarm with the same period', async () => {
    await ensureAlarm(settings(30));
    const spy = vi.spyOn(browser.alarms, 'create');
    await ensureAlarm(settings(30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('recreates the alarm when the period differs', async () => {
    await ensureAlarm(settings(30));
    await ensureAlarm(settings(10));
    const a = await browser.alarms.get(ALARM_NAME);
    expect(a?.periodInMinutes).toBe(10);
  });
});

describe('handleAlarm', () => {
  it.each(['idle', 'locked'] as const)('runs immediately when %s', async (state) => {
    const run = vi.fn(async () => {});
    await handleAlarm(async () => state, run);
    expect(run).toHaveBeenCalledWith('alarm');
    expect(await runPending()).toBeUndefined();
  });

  it('defers by setting runPending when active', async () => {
    const run = vi.fn(async () => {});
    await handleAlarm(async () => 'active', run);
    expect(run).not.toHaveBeenCalled();
    expect(await runPending()).toBe(true);
  });
});

describe('handleIdleChange', () => {
  it.each(['idle', 'locked'] as const)('runs and clears the flag on %s', async (state) => {
    await browser.storage.session.set({ runPending: true });
    const run = vi.fn(async () => {});
    await handleIdleChange(state, run);
    expect(run).toHaveBeenCalledWith('idle');
    expect(await runPending()).toBeUndefined();
  });

  it('clears the flag before running', async () => {
    await browser.storage.session.set({ runPending: true });
    let seen: unknown = 'unset';
    await handleIdleChange('idle', async () => {
      seen = await runPending();
    });
    expect(seen).toBeUndefined();
  });

  it('does nothing when no flag is set', async () => {
    const run = vi.fn(async () => {});
    await handleIdleChange('idle', run);
    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing when active', async () => {
    await browser.storage.session.set({ runPending: true });
    const run = vi.fn(async () => {});
    await handleIdleChange('active', run);
    expect(run).not.toHaveBeenCalled();
    expect(await runPending()).toBe(true);
  });
});
