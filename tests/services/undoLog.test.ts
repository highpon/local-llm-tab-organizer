import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { clearUndo, loadUndo, saveUndo, undoLast, type UndoPorts } from '../../services/undoLog';

const AT = Date.now();
const DAY = 24 * 60 * 60_000;

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
      at: AT,
      closed: [
        { tabId: 1, windowId: 10, url: 'https://a.example/' , cookieStoreId: 'firefox-default' },
        { tabId: 2, windowId: 10, url: 'https://b.example/' , cookieStoreId: 'firefox-default' },
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
      at: AT,
      closed: [
        { tabId: 1, windowId: 10, url: 'https://a.example/' , cookieStoreId: 'firefox-default' },
        { tabId: 2, windowId: 20, url: 'https://b.example/' , cookieStoreId: 'firefox-default' },
      ],
      grouped: [],
    });
    const ports = makePorts([{ sessionId: 's1', url: 'https://a.example/' }]);
    expect(await undoLast(ports)).toEqual({ restored: 2, ungrouped: 0 });
    expect(ports.restore).toHaveBeenCalledWith('s1');
    expect(ports.create).toHaveBeenCalledTimes(1);
    expect(ports.create).toHaveBeenCalledWith('https://b.example/', 20, 'firefox-default');
  });

  it('uses distinct sessions for tabs closed with the same URL', async () => {
    await saveUndo({
      at: AT,
      closed: [
        { tabId: 1, windowId: 10, url: 'https://a.example/' , cookieStoreId: 'firefox-default' },
        { tabId: 2, windowId: 10, url: 'https://a.example/' , cookieStoreId: 'firefox-default' },
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
      at: AT,
      closed: [
        { tabId: 1, windowId: 10, url: 'https://a.example/' , cookieStoreId: 'firefox-default' },
        { tabId: 2, windowId: 11, url: 'https://a.example/' , cookieStoreId: 'firefox-default' },
      ],
      grouped: [],
    });
    const ports = makePorts([{ sessionId: 's1', url: 'https://a.example/' }]);
    await undoLast(ports);
    expect(ports.restore).toHaveBeenCalledTimes(1);
    expect(ports.create).toHaveBeenCalledWith('https://a.example/', 11, 'firefox-default');
  });

  it('recreates a missing tab in its original container', async () => {
    await saveUndo({
      at: AT,
      closed: [{ tabId: 1, windowId: 10, url: 'https://a.example/', cookieStoreId: 'firefox-container-2' }],
      grouped: [],
    });
    const ports = makePorts([]);
    await undoLast(ports);
    expect(ports.create).toHaveBeenCalledWith('https://a.example/', 10, 'firefox-container-2');
  });

  it('ungroups each grouped tab', async () => {
    await saveUndo({ at: AT, closed: [], grouped: [5, 6] });
    const ports = makePorts([]);
    expect(await undoLast(ports)).toEqual({ restored: 0, ungrouped: 2 });
    expect(ports.ungroup).toHaveBeenCalledWith([5]);
    expect(ports.ungroup).toHaveBeenCalledWith([6]);
  });

  it('still ungroups the other tabs when one of them is gone', async () => {
    await saveUndo({ at: AT, closed: [], grouped: [5, 6, 7] });
    const ports = makePorts([]);
    vi.mocked(ports.ungroup).mockImplementation(async (ids) => {
      if (ids.includes(6)) throw new Error('Invalid tab ID: 6');
    });
    expect(await undoLast(ports)).toEqual({ restored: 0, ungrouped: 2 });
    expect(ports.ungroup).toHaveBeenCalledWith([7]);
  });

  it('recreates the tab when restoring the session fails', async () => {
    await saveUndo({
      at: AT, closed: [{ tabId: 1, windowId: 10, url: 'https://a.example/', cookieStoreId: 'firefox-default' }], grouped: [],
    });
    const ports = makePorts([{ sessionId: 's1', url: 'https://a.example/' }]);
    vi.mocked(ports.restore).mockRejectedValue(new Error('gone'));
    expect(await undoLast(ports)).toEqual({ restored: 1, ungrouped: 0 });
    expect(ports.create).toHaveBeenCalledWith('https://a.example/', 10, 'firefox-default');
  });

  it('does not count a tab when both restore and create fail', async () => {
    await saveUndo({
      at: AT, closed: [{ tabId: 1, windowId: 10, url: 'https://a.example/', cookieStoreId: 'firefox-default' }], grouped: [],
    });
    const ports = makePorts([{ sessionId: 's1', url: 'https://a.example/' }]);
    vi.mocked(ports.restore).mockRejectedValue(new Error('gone'));
    vi.mocked(ports.create).mockRejectedValue(new Error('no window'));
    expect(await undoLast(ports)).toEqual({ restored: 0, ungrouped: 0 });
  });

  it('matches recently closed sessions by normalized URL', async () => {
    await saveUndo({
      at: AT, closed: [{ tabId: 1, windowId: 10, url: 'https://a.example/x', cookieStoreId: 'firefox-default' }], grouped: [],
    });
    const ports = makePorts([{ sessionId: 's1', url: 'https://www.a.example/x/?utm_source=feed#top' }]);
    await undoLast(ports);
    expect(ports.restore).toHaveBeenCalledWith('s1');
    expect(ports.create).not.toHaveBeenCalled();
  });

  it('a second undo (double click) does nothing', async () => {
    await saveUndo({
      at: AT, closed: [{ tabId: 1, windowId: 10, url: 'https://a.example/', cookieStoreId: 'firefox-default' }], grouped: [5],
    });
    const ports = makePorts([{ sessionId: 's1', url: 'https://a.example/' }]);
    const [a, b] = await Promise.all([undoLast(ports), undoLast(ports)]);
    expect([a, b]).toContainEqual({ restored: 0, ungrouped: 0 });
    expect(ports.restore).toHaveBeenCalledTimes(1);
    expect(ports.ungroup).toHaveBeenCalledTimes(1);
    expect(await undoLast(ports)).toEqual({ restored: 0, ungrouped: 0 });
    expect(ports.restore).toHaveBeenCalledTimes(1);
  });

  it('claims the record before restoring anything', async () => {
    await saveUndo({ at: AT, closed: [], grouped: [5] });
    const ports = makePorts([]);
    let seen: unknown = 'unset';
    vi.mocked(ports.ungroup).mockImplementation(async () => { seen = await loadUndo(); });
    await undoLast(ports);
    expect(seen).toBeNull();
  });

  it('ignores and removes a record older than 24 hours', async () => {
    await saveUndo({ at: AT - DAY - 1, closed: [], grouped: [5] });
    expect(await loadUndo(AT)).toBeNull();
    const ports = makePorts([]);
    expect(await undoLast(ports, AT)).toEqual({ restored: 0, ungrouped: 0 });
    expect(ports.ungroup).not.toHaveBeenCalled();
    expect((await browser.storage.local.get('undo')).undo).toBeUndefined();
  });

  it('keeps a record younger than 24 hours', async () => {
    await saveUndo({ at: AT - DAY + 60_000, closed: [], grouped: [5] });
    expect(await loadUndo(AT)).not.toBeNull();
  });

  it('clearUndo removes the record', async () => {
    await saveUndo({ at: AT, closed: [], grouped: [5] });
    await clearUndo();
    expect(await loadUndo()).toBeNull();
  });

  it('clears the record after running', async () => {
    await saveUndo({ at: AT, closed: [], grouped: [5] });
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
    await saveUndo({ at: AT, closed: [], grouped: [1] });
    await saveUndo({ at: AT + 1, closed: [], grouped: [2] });
    expect((await loadUndo())?.at).toBe(AT + 1);
  });
});
