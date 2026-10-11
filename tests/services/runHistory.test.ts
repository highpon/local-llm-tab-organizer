import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { appendRun, listRuns, type RunRecord } from '../../services/runHistory';

const rec = (at: number): RunRecord => ({
  at, trigger: 'manual', closed: 0, grouped: 0, method: null, skipped: false,
});

describe('runHistory', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('returns an empty list when nothing was recorded', async () => {
    expect(await listRuns()).toEqual([]);
  });

  it('keeps the newest 20 runs, newest first', async () => {
    for (let i = 1; i <= 21; i++) await appendRun(rec(i));
    const runs = await listRuns();
    expect(runs).toHaveLength(20);
    expect(runs[0]!.at).toBe(21);
    expect(runs[19]!.at).toBe(2);
  });
});
