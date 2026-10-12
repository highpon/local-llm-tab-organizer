import type { Mode } from '../core/types';

export type ClassifierKind = 'onDevice' | 'llm' | 'domain';

export interface Settings {
  dedupe: { mode: Mode; acrossWindows: boolean };
  grouping: { mode: Mode };
  classifier: ClassifierKind;
  llm: { baseUrl: string; model: string; timeoutSeconds: number };
  schedule: { intervalMinutes: number; idleSeconds: number };
}

export const DEFAULT_SETTINGS: Settings = {
  dedupe: { mode: 'auto', acrossWindows: false },
  grouping: { mode: 'suggest' },
  classifier: 'onDevice',
  llm: { baseUrl: 'http://localhost:11434/v1', model: '', timeoutSeconds: 30 },
  schedule: { intervalMinutes: 30, idleSeconds: 60 },
};

const STORAGE_KEY = 'settings';
const MIN_IDLE_SECONDS = 15; // lower bound of the idle API
const MIN_INTERVAL_MINUTES = 1;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const MODES: readonly string[] = ['auto', 'suggest', 'off'];
const pickMode = (v: unknown, d: Mode): Mode => (typeof v === 'string' && MODES.includes(v) ? (v as Mode) : d);
const CLASSIFIERS: readonly string[] = ['onDevice', 'llm', 'domain'];
/** A stored classifier wins; otherwise settings from before it existed map llm.enabled: true to 'llm'. */
const pickClassifier = (v: unknown, legacyLlmEnabled: unknown, d: ClassifierKind): ClassifierKind => {
  if (typeof v === 'string' && CLASSIFIERS.includes(v)) return v as ClassifierKind;
  if (v === undefined && legacyLlmEnabled === true) return 'llm';
  return d;
};
const pickBool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const pickString = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const pickNumber = (v: unknown, d: number, min: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : Math.max(min, d);

function mergeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = isRecord(raw) ? raw : {};
  const dedupe = isRecord(r.dedupe) ? r.dedupe : {};
  const grouping = isRecord(r.grouping) ? r.grouping : {};
  const llm = isRecord(r.llm) ? r.llm : {};
  const schedule = isRecord(r.schedule) ? r.schedule : {};
  return {
    dedupe: {
      mode: pickMode(dedupe.mode, d.dedupe.mode),
      acrossWindows: pickBool(dedupe.acrossWindows, d.dedupe.acrossWindows),
    },
    grouping: { mode: pickMode(grouping.mode, d.grouping.mode) },
    classifier: pickClassifier(r.classifier, llm.enabled, d.classifier),
    llm: {
      baseUrl: pickString(llm.baseUrl, d.llm.baseUrl),
      model: pickString(llm.model, d.llm.model),
      timeoutSeconds: pickNumber(llm.timeoutSeconds, d.llm.timeoutSeconds, 1),
    },
    schedule: {
      intervalMinutes: pickNumber(schedule.intervalMinutes, d.schedule.intervalMinutes, MIN_INTERVAL_MINUTES),
      idleSeconds: pickNumber(schedule.idleSeconds, d.schedule.idleSeconds, MIN_IDLE_SECONDS),
    },
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return mergeSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(s: Settings): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: s });
}
