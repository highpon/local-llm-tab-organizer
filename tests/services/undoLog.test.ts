import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { loadUndo, saveUndo, undoLast, type UndoPorts } from '../../services/undoLog';

function makePorts(recent: { sessionId: string; url: string }[]): UndoPorts {
  return {
    getRecentlyClosed: vi.fn(async () => recent),
    restore: vi.fn(async () => {}),
    create: vi.fn(async () => {}),
    ungroup: vi.fn(async () => {}),
  };
}

describe('undoLog', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('restores both closed tabs from recently closed sessions', async () => {
    await saveUndo({
      at: 1,
      closed: [
        { tabId: 1, windowId: 10, url: 'https://a.example/' },
        { tabId: 2, windowId: 10, url: 'https://b.example/' },
      ],
      grouped: [],
    });
    const ports = makePorts([
      { sessionId: 's1', url: 'https://a.example/' },
      { sessionId: 's2', url: 'https://b.example/' },
    ]);
    expect(await undoLast(ports)).toEqual({ restored: 2, ungrouped: 0 });
    expect(ports.restore).toHaveBeenCalledTimes(2);
    expect(ports.create).not.toHaveBeenCalled();
    expect(ports.ungroup).not.toHaveBeenCalled();
  });

  it('recreates a missing tab in its original window', async () => {
    await saveUndo({
      at: 1,
      closed: [
        { tabId: 1, windowId: 10, url: 'https://a.example/' },
        { tabId: 2, windowId: 20, url: 'https://b.example/' },
      ],
      grouped: [],
    });
    const ports = makePorts([{ sessionId: 's1', url: 'https://a.example/' }]);
    expect(await undoLast(ports)).toEqual({ restored: 2, ungrouped: 0 });
    expect(ports.restore).toHaveBeenCalledWith('s1');
    expect(ports.create).toHaveBeenCalledTimes(1);
    expect(ports.create).toHaveBeenCalledWith('https://b.example/', 20);
  });

  it('uses distinct sessions for tabs closed with the same URL', async () => {
    await saveUndo({
      at: 1,
      closed: [
        { tabId: 1, windowId: 10, url: 'https://a.example/' },
        { tabId: 2, windowId: 10, url: 'https://a.example/' },
      ],
      grouped: [],
    });
    const ports = makePorts([
      { sessionId: 's1', url: 'https://a.example/' },
      { sessionId: 's2', url: 'https://a.example/' },
    ]);
    await undoLast(ports);
    const ids = vi.mocked(ports.restore).mock.calls.map((c) => c[0]);
    expect(ids.sort()).toEqual(['s1', 's2']);
    expect(ports.create).not.toHaveBeenCalled();
  });

  it('does not reuse a session when only one matches', async () => {
    await saveUndo({
      at: 1,
      closed: [
        { tabId: 1, windowId: 10, url: 'https://a.example/' },
        { tabId: 2, windowId: 11, url: 'https://a.example/' },
      ],
      grouped: [],
    });
    const ports = makePorts([{ sessionId: 's1', url: 'https://a.example/' }]);
    await undoLast(ports);
    expect(ports.restore).toHaveBeenCalledTimes(1);
    expect(ports.create).toHaveBeenCalledWith('https://a.example/', 11);
  });

  it('ungroups grouped tabs once', async () => {
    await saveUndo({ at: 1, closed: [], grouped: [5, 6] });
    const ports = makePorts([]);
    expect(await undoLast(ports)).toEqual({ restored: 0, ungrouped: 2 });
    expect(ports.ungroup).toHaveBeenCalledTimes(1);
    expect(ports.ungroup).toHaveBeenCalledWith([5, 6]);
  });

  it('clears the record after running', async () => {
    await saveUndo({ at: 1, closed: [], grouped: [5] });
    await undoLast(makePorts([]));
    expect(await loadUndo()).toBeNull();
  });

  it('does nothing when there is no record', async () => {
    const ports = makePorts([]);
    expect(await undoLast(ports)).toEqual({ restored: 0, ungrouped: 0 });
    expect(ports.getRecentlyClosed).not.toHaveBeenCalled();
    expect(ports.restore).not.toHaveBeenCalled();
    expect(ports.create).not.toHaveBeenCalled();
    expect(ports.ungroup).not.toHaveBeenCalled();
  });

  it('keeps only the latest record', async () => {
    await saveUndo({ at: 1, closed: [], grouped: [1] });
    await saveUndo({ at: 2, closed: [], grouped: [2] });
    expect((await loadUndo())?.at).toBe(2);
  });
});
