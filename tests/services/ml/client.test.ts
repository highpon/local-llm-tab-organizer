import { describe, expect, it, vi } from 'vitest';
import { createMlClient } from '../../../services/ml/client';
import type { MlRequest, MlResponse } from '../../../services/ml/protocol';

class FakeWorker {
  sent: MlRequest[] = [];
  onmessage: ((ev: MessageEvent<MlResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage(msg: MlRequest) { this.sent.push(msg); }
  reply(msg: MlResponse) { this.onmessage?.({ data: msg } as MessageEvent<MlResponse>); }
}

function setup() {
  const w = new FakeWorker();
  const client = createMlClient(() => w as unknown as Worker);
  return { w, client };
}

describe('createMlClient', () => {
  it('load forwards progress and resolves on ok', async () => {
    const { w, client } = setup();
    const seen: number[] = [];
    const p = client.load((x) => seen.push(x));
    const id = w.sent[0]!.id;
    expect(w.sent[0]).toMatchObject({ type: 'load', remote: true });
    w.reply({ type: 'progress', progress: 0.5 });
    w.reply({ type: 'progress', progress: 1 });
    w.reply({ id, ok: true, result: null });
    await expect(p).resolves.toBeUndefined();
    expect(seen).toEqual([0.5, 1]);
  });

  it('load can be limited to cached models', async () => {
    const { w, client } = setup();
    void client.load(undefined, false);
    expect(w.sent[0]).toMatchObject({ type: 'load', remote: false });
  });

  it('embed resolves with the result of the matching id', async () => {
    const { w, client } = setup();
    const a = client.embed(['a']);
    const b = client.embed(['b']);
    const [ra, rb] = w.sent;
    expect(ra).toMatchObject({ type: 'embed', texts: ['a'] });
    w.reply({ id: rb!.id, ok: true, result: [[2]] });
    w.reply({ id: ra!.id, ok: true, result: [[1]] });
    await expect(a).resolves.toEqual([[1]]);
    await expect(b).resolves.toEqual([[2]]);
  });

  it('topic sends prompts and resolves with labels', async () => {
    const { w, client } = setup();
    const p = client.topic(['x']);
    expect(w.sent[0]).toMatchObject({ type: 'topic', prompts: ['x'] });
    w.reply({ id: w.sent[0]!.id, ok: true, result: ['Dogs'] });
    await expect(p).resolves.toEqual(['Dogs']);
  });

  it('a failed response rejects with the error text', async () => {
    const { w, client } = setup();
    const p = client.embed(['a']);
    w.reply({ id: w.sent[0]!.id, ok: false, error: 'boom' });
    await expect(p).rejects.toThrow('boom');
  });

  it('terminate rejects pending requests', async () => {
    const { w, client } = setup();
    const p = client.embed(['a']);
    client.terminate();
    await expect(p).rejects.toThrow();
    expect(w.terminate).toHaveBeenCalledTimes(1);
  });

  it('worker error event rejects pending requests', async () => {
    const { w, client } = setup();
    const a = client.embed(['a']);
    const b = client.load();
    w.onerror?.({ message: 'wasm failed' } as ErrorEvent);
    await expect(a).rejects.toThrow('wasm failed');
    await expect(b).rejects.toThrow('wasm failed');
  });

  it('spawns the worker lazily, once', () => {
    const spawn = vi.fn(() => new FakeWorker() as unknown as Worker);
    const client = createMlClient(spawn);
    expect(spawn).not.toHaveBeenCalled();
    void client.embed(['a']).catch(() => {});
    void client.embed(['b']).catch(() => {});
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
