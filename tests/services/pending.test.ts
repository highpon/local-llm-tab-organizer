import { describe, expect, it } from 'vitest';
import type { CloseEntry, GroupingPlan } from '../../core/types';
import { planSignature } from '../../services/pending';

const close = (tabId: number, keepTabId: number): CloseEntry => ({
  tabId, keepTabId, windowId: 1, url: 'https://a.com/', cookieStoreId: 'firefox-default', acrossWindows: false,
});
const add = (tabId: number) => ({ tabId, windowId: 1, url: `https://a.com/${tabId}` });

describe('planSignature', () => {
  it('ignores order', () => {
    expect(planSignature('dedupe', { closes: [close(1, 3), close(2, 3)] }))
      .toBe(planSignature('dedupe', { closes: [close(2, 3), close(1, 3)] }));
  });
  it('changes when a tab or its keep changes', () => {
    const base = planSignature('dedupe', { closes: [close(1, 3)] });
    expect(planSignature('dedupe', { closes: [close(1, 4)] })).not.toBe(base);
    expect(planSignature('dedupe', { closes: [close(2, 3)] })).not.toBe(base);
  });
  it('compares grouping by tab → target, case-insensitive on new titles', () => {
    const a: GroupingPlan = { addToExisting: [{ groupId: 9, tabs: [add(1)] }], createNew: [{ windowId: 1, title: 'Dev', tabs: [add(2), add(3)] }] };
    const b: GroupingPlan = { addToExisting: [{ groupId: 9, tabs: [add(1)] }], createNew: [{ windowId: 1, title: 'dev ', tabs: [add(3), add(2)] }] };
    const c: GroupingPlan = { addToExisting: [], createNew: [{ windowId: 1, title: 'Dev', tabs: [add(1), add(2), add(3)] }] };
    expect(planSignature('grouping', a)).toBe(planSignature('grouping', b));
    expect(planSignature('grouping', a)).not.toBe(planSignature('grouping', c));
  });
  it('is null for a missing plan', () => {
    expect(planSignature('grouping', undefined)).toBeNull();
  });
});
