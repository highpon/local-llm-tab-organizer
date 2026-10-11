import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { parseAssignments, classifyTabs } from '../../services/llmClassifier';
import { LlmError } from '../../services/llmClient';
import type { TabInfo } from '../../core/types';

beforeEach(() => { fakeBrowser.reset(); });

const cfg = { enabled: true, baseUrl: 'http://x/v1', model: 'm', timeoutSeconds: 5 };
const tab = (id: number, url = `https://site${id}.example.com/p`): TabInfo => ({
  id, windowId: 7, url, title: `Title ${id}`, pinned: false, active: false,
  audible: false, lastAccessed: 1234567890123, groupId: -1,
});
const reply = (...a: [number, string][]) =>
  JSON.stringify({ assignments: a.map(([tabId, group]) => ({ tabId, group })) });

describe('parseAssignments', () => {
  const ids = new Set([1, 2]);
  const raw = reply([1, 'A'], [2, 'B']);
  it('reads raw JSON', () => {
    expect(parseAssignments(raw, ids)).toEqual([{ tabId: 1, group: 'A' }, { tabId: 2, group: 'B' }]);
  });
  it('reads fenced JSON', () => {
    expect(parseAssignments('```json\n' + raw + '\n```', ids)).toHaveLength(2);
  });
  it('reads JSON surrounded by prose', () => {
    expect(parseAssignments('Here you go: ' + raw + ' Hope it helps!', ids)).toHaveLength(2);
  });
  it('drops unknown ids and invalid groups', () => {
    const c = JSON.stringify({ assignments: [
      { tabId: 1, group: 'A' }, { tabId: 99, group: 'Z' }, { tabId: 2, group: '' },
      { tabId: 2, group: 5 }, { tabId: 2 }, null,
    ] });
    expect(parseAssignments(c, ids)).toEqual([{ tabId: 1, group: 'A' }]);
  });
  it('returns [] when unreadable', () => {
    expect(parseAssignments('nothing here', ids)).toEqual([]);
    expect(parseAssignments('{bad json}', ids)).toEqual([]);
    expect(parseAssignments('{"foo":1}', ids)).toEqual([]);
  });
});

describe('classifyTabs', () => {
  it('skips the LLM when disabled', async () => {
    const chat = vi.fn();
    const r = await classifyTabs([tab(1)], [], { ...cfg, enabled: false }, chat);
    expect(chat).not.toHaveBeenCalled();
    expect(r.method).toBe('domain');
    expect(r.assignments).toHaveLength(1);
  });
  it('returns llm when every tab is assigned', async () => {
    const chat = vi.fn(async () => reply([1, 'A'], [2, 'B']));
    const r = await classifyTabs([tab(1), tab(2)], [], cfg, chat);
    expect(r.method).toBe('llm');
    expect(r.assignments).toEqual([{ tabId: 1, group: 'A' }, { tabId: 2, group: 'B' }]);
    expect(r.error).toBeUndefined();
  });
  it('fills gaps with domain classification and returns mixed', async () => {
    const chat = vi.fn(async () => reply([1, 'A']));
    const r = await classifyTabs([tab(1), tab(2)], [], cfg, chat);
    expect(r.method).toBe('mixed');
    expect(r.assignments.map(a => a.tabId).sort()).toEqual([1, 2]);
    expect(r.assignments.find(a => a.tabId === 1)!.group).toBe('A');
  });
  it('falls back to domain on LlmError and reports the kind', async () => {
    const chat = vi.fn(async () => { throw new LlmError('forbidden', 'no'); });
    const r = await classifyTabs([tab(1), tab(2)], [], cfg, chat);
    expect(r.method).toBe('domain');
    expect(r.error).toBe('forbidden');
    expect(r.assignments).toHaveLength(2);
  });
  it('rethrows non-LlmError errors', async () => {
    const chat = vi.fn(async () => { throw new Error('boom'); });
    await expect(classifyTabs([tab(1)], [], cfg, chat)).rejects.toThrow('boom');
  });
  it('is mixed when one batch succeeds and another fails', async () => {
    const tabs = Array.from({ length: 60 }, (_, i) => tab(i + 1));
    let n = 0;
    const chat = vi.fn(async () => {
      if (n++ === 1) throw new LlmError('timeout', 't');
      return JSON.stringify({ assignments: tabs.slice(0, 50).map(t => ({ tabId: t.id, group: 'G' })) });
    });
    const r = await classifyTabs(tabs, [], cfg, chat);
    expect(r.method).toBe('mixed');
    expect(r.error).toBe('timeout');
    expect(r.assignments).toHaveLength(60);
  });
  it('batches 120 tabs into 50 + 50 + 20', async () => {
    const tabs = Array.from({ length: 120 }, (_, i) => tab(i + 1));
    const sizes: number[] = [];
    const chat = vi.fn(async (m: { role: string; content: string }[]) => {
      const list = JSON.parse(m[1]!.content).tabs as { id: number }[];
      sizes.push(list.length);
      return JSON.stringify({ assignments: list.map(t => ({ tabId: t.id, group: 'G' })) });
    });
    const r = await classifyTabs(tabs, [], cfg, chat);
    expect(chat).toHaveBeenCalledTimes(3);
    expect(sizes).toEqual([50, 50, 20]);
    expect(r.method).toBe('llm');
    expect(r.assignments).toHaveLength(120);
  });
  it('sends only id/title/url plus existing group names', async () => {
    const chat = vi.fn(async (_m: { role: string; content: string }[]) => reply([1, 'A']));
    await classifyTabs([tab(1)], ['Work', 'Reading'], cfg, chat);
    const [system, user] = chat.mock.calls[0]![0] as [{ content: string }, { content: string }];
    const all = system.content + user.content;
    expect(all).toContain('Work');
    expect(all).toContain('Reading');
    expect(JSON.parse(user.content).tabs).toEqual([
      { id: 1, title: 'Title 1', url: 'https://site1.example.com/p' },
    ]);
    expect(all).not.toContain('lastAccessed');
    expect(all).not.toContain('1234567890123');
    expect(all).not.toContain('windowId');
  });
  it('ignores the same tab assigned twice by keeping the first', async () => {
    const chat = vi.fn(async () => reply([1, 'A'], [1, 'B']));
    const r = await classifyTabs([tab(1)], [], cfg, chat);
    expect(r.assignments).toEqual([{ tabId: 1, group: 'A' }]);
    expect(r.method).toBe('llm');
  });
});
