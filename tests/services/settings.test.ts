import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../../services/settings';

describe('settings', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('returns defaults when nothing is stored', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('deep-merges partial stored settings over defaults', async () => {
    await browser.storage.local.set({ settings: { llm: { model: 'qwen3' } } });
    const s = await loadSettings();
    expect(s.llm.model).toBe('qwen3');
    expect(s.llm.baseUrl).toBe(DEFAULT_SETTINGS.llm.baseUrl);
    expect(s.dedupe).toEqual(DEFAULT_SETTINGS.dedupe);
  });

  it('clamps idleSeconds to 15 and intervalMinutes to 1', async () => {
    await browser.storage.local.set({ settings: { schedule: { idleSeconds: 5, intervalMinutes: 0 } } });
    const s = await loadSettings();
    expect(s.schedule.idleSeconds).toBe(15);
    expect(s.schedule.intervalMinutes).toBe(1);
  });

  it('falls back to defaults for wrong types without throwing', async () => {
    await browser.storage.local.set({
      settings: { dedupe: 'x', llm: { enabled: 'yes', timeoutSeconds: 'a' }, schedule: { idleSeconds: null } },
    });
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    await browser.storage.local.set({ settings: 42 });
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips saved settings', async () => {
    const s: Settings = {
      dedupe: { mode: 'suggest', acrossWindows: true },
      grouping: { mode: 'off' },
      classifier: 'llm',
      llm: { baseUrl: 'http://x/v1', model: 'm', timeoutSeconds: 10 },
      schedule: { intervalMinutes: 5, idleSeconds: 30 },
    };
    await saveSettings(s);
    expect(await loadSettings()).toEqual(s);
  });

  it('defaults to onDevice', async () => {
    expect((await loadSettings()).classifier).toBe('onDevice');
  });

  it('migrates llm.enabled true to llm', async () => {
    await browser.storage.local.set({
      settings: { llm: { enabled: true, baseUrl: 'http://h/v1', model: 'm', timeoutSeconds: 9 } },
    });
    const s = await loadSettings();
    expect(s.classifier).toBe('llm');
    expect(s.llm).toEqual({ baseUrl: 'http://h/v1', model: 'm', timeoutSeconds: 9 });
  });

  it('migrates llm.enabled false to onDevice', async () => {
    await browser.storage.local.set({ settings: { llm: { enabled: false } } });
    expect((await loadSettings()).classifier).toBe('onDevice');
  });

  it('keeps a stored classifier over llm.enabled', async () => {
    await browser.storage.local.set({ settings: { classifier: 'domain', llm: { enabled: true } } });
    expect((await loadSettings()).classifier).toBe('domain');
  });

  it('rejects an unknown classifier', async () => {
    await browser.storage.local.set({ settings: { classifier: 'x' } });
    expect((await loadSettings()).classifier).toBe('onDevice');
  });
});
