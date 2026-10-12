import type { ClassifyErrorKind, ClassifyMethod } from '../core/types';

export type Trigger = 'alarm' | 'idle' | 'manual';
export interface RunRecord {
  at: number;
  trigger: Trigger;
  closed: number;
  grouped: number;
  method: ClassifyMethod | null;
  classifyError?: ClassifyErrorKind; // why classification fell back, e.g. the model was not ready
  error?: string;
  skipped: boolean; // true when the run was skipped because another run held the lock
}

const STORAGE_KEY = 'history';
const MAX_RUNS = 20;

export async function listRuns(): Promise<RunRecord[]> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as RunRecord[] | undefined) ?? [];
}

export async function appendRun(r: RunRecord): Promise<void> {
  const runs = await listRuns();
  await browser.storage.local.set({ [STORAGE_KEY]: [r, ...runs].slice(0, MAX_RUNS) });
}
