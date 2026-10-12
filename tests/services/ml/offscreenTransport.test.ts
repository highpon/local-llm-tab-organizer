import { describe, expect, it, vi } from 'vitest';
import type { WorkerLike } from '../../../services/ml/client';
import type { PortLike } from '../../../services/ml/offscreenRelay';
import { createOffscreenHost, type OffscreenDeps } from '../../../services/ml/offscreenTransport';
import type { MlRequest, MlResponse } from '../../../services/ml/protocol';

class FakePort implements PortLike {
  name = 'ml';
  sent: unknown[] = [];
  private msgFns: ((m: unknown) => void)[] = [];
  private discFns: (() => void)[] = [];
  postMessage(msg: unknown) { this.sent.push(msg); }
  onMessage = { addListener: (fn: (m: unknown) => void) => { this.msgFns.push(fn); } };
  onDisconnect = { addListener: (fn: () => void) => { this.discFns.push(fn); } };
  disconnect = vi.fn();
  emit(msg: unknown) { this.msgFns.forEach((f) => f(msg)); }
  disconnectFromOtherSide() { this.discFns.forEach((f) => f()); }
}

/** ready: relayReady arrives asynchronously; fail: disconnects before ready; manual: the test drives it. */
type Mode = 'ready' | 'fail' | 'manual';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(opts: { hasDocument?: boolean; script?: Mode[] } = {}) {
  let docExists = opts.hasDocument ?? false;
  const script = [...(opts.script ?? [])];
  const ports: FakePort[] = [];
  const deps = {
    hasDocument: vi.fn(async () => docExists),
    createDocument: vi.fn(async () => { docExists = true; }),
    closeDocument: vi.fn(async () => { docExists = false; }),
    connect: vi.fn((): PortLike => {
      const mode = script.shift() ?? 'ready';
      const p = new FakePort();
      ports.push(p);
      if (mode === 'ready') queueMicrotask(() => p.emit({ type: 'relayReady' }));
      else if (mode === 'fail') queueMicrotask(() => p.disconnectFromOtherSide());
      return p;
    }),
    delay: vi.fn(async (_ms: number) => {}),
  } satisfies OffscreenDeps;
  const host = createOffscreenHost(deps);
  return { deps, host, ports };
}

function spawnWatched(host: { spawn(): WorkerLike }) {
  const w = host.spawn();
  const onmessage = vi.fn<(ev: { data: MlResponse }) => void>();
  const onerror = vi.fn<(ev: { message: string }) => void>();
  w.onmessage = onmessage;
  w.onerror = onerror;
  return { w, onmessage, onerror };
}

const req = (id: number): MlRequest => ({ id, type: 'embed', texts: [`t${id}`] });

describe('createOffscreenHost', () => {
  it('reuses an existing document', async () => {
    const { deps, host, ports } = setup({ hasDocument: true });
    const { w } = spawnWatched(host);
    w.postMessage(req(1));
    await flush();
    expect(deps.createDocument).not.toHaveBeenCalled();
    expect(ports[0]!.sent).toEqual([req(1)]);
  });

  it('concurrent first messages create the document once', async () => {
    const { deps, host, ports } = setup();
    const a = spawnWatched(host);
    const b = spawnWatched(host);
    a.w.postMessage(req(1));
    b.w.postMessage(req(2));
    await flush();
    expect(deps.createDocument).toHaveBeenCalledTimes(1);
    expect(ports).toHaveLength(2);
  });

  it('queues messages until relayReady', async () => {
    const { host, ports } = setup({ script: ['manual'] });
    const { w } = spawnWatched(host);
    w.postMessage(req(1));
    w.postMessage(req(2));
    await flush();
    expect(ports).toHaveLength(1);
    expect(ports[0]!.sent).toEqual([]);
    ports[0]!.emit({ type: 'relayReady' });
    expect(ports[0]!.sent).toEqual([req(1), req(2)]);
    w.postMessage(req(3));
    expect(ports[0]!.sent).toEqual([req(1), req(2), req(3)]);
  });

  it('retries a Port that closes before relayReady', async () => {
    const { deps, host, ports } = setup({ script: ['fail', 'fail', 'ready'] });
    const { w, onerror } = spawnWatched(host);
    w.postMessage(req(1));
    w.postMessage(req(2));
    await flush();
    expect(deps.connect).toHaveBeenCalledTimes(3);
    expect(deps.delay).toHaveBeenCalledWith(200);
    expect(ports[2]!.sent).toEqual([req(1), req(2)]);
    expect(onerror).not.toHaveBeenCalled();
  });

  it('gives up after 5 failed connects', async () => {
    const { deps, host } = setup({ script: ['fail', 'fail', 'fail', 'fail', 'fail', 'fail'] });
    const { w, onerror } = spawnWatched(host);
    w.postMessage(req(1));
    await flush();
    expect(deps.connect).toHaveBeenCalledTimes(5);
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(onerror).toHaveBeenCalledWith({ message: 'ML offscreen document closed' });
  });

  it('forwards responses to onmessage', async () => {
    const { host, ports } = setup();
    const { w, onmessage } = spawnWatched(host);
    w.postMessage(req(1));
    await flush();
    ports[0]!.emit({ id: 1, ok: true, result: 1 });
    expect(onmessage).toHaveBeenCalledWith({ data: { id: 1, ok: true, result: 1 } });
  });

  it('workerError becomes onerror', async () => {
    const { host, ports } = setup();
    const { w, onerror, onmessage } = spawnWatched(host);
    w.postMessage(req(1));
    await flush();
    ports[0]!.emit({ type: 'workerError', message: 'boom' });
    expect(onerror).toHaveBeenCalledWith({ message: 'boom' });
    expect(onmessage).not.toHaveBeenCalled();
  });

  it('unexpected disconnect after ready raises onerror', async () => {
    const { host, ports } = setup();
    const { w, onerror } = spawnWatched(host);
    w.postMessage(req(1));
    await flush();
    ports[0]!.disconnectFromOtherSide();
    expect(onerror).toHaveBeenCalledTimes(1);
    expect(onerror).toHaveBeenCalledWith({ message: 'ML offscreen document closed' });
  });

  it('terminate disconnects without onerror and closes the last document', async () => {
    const { deps, host, ports } = setup();
    const { w, onerror } = spawnWatched(host);
    w.postMessage(req(1));
    await flush();
    w.terminate();
    await flush();
    expect(ports[0]!.disconnect).toHaveBeenCalled();
    expect(onerror).not.toHaveBeenCalled();
    expect(deps.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('closing one of two Ports keeps the document', async () => {
    const { deps, host } = setup();
    const a = spawnWatched(host);
    const b = spawnWatched(host);
    a.w.postMessage(req(1));
    b.w.postMessage(req(2));
    await flush();
    a.w.terminate();
    await flush();
    expect(deps.closeDocument).not.toHaveBeenCalled();
    b.w.terminate();
    await flush();
    expect(deps.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('waits for a pending close before creating', async () => {
    const { deps, host } = setup();
    const close = deferred();
    deps.closeDocument.mockImplementationOnce(() => close.promise);
    const a = spawnWatched(host);
    a.w.postMessage(req(1));
    await flush();
    a.w.terminate();
    await flush();
    expect(deps.closeDocument).toHaveBeenCalledTimes(1);
    deps.createDocument.mockClear();
    deps.hasDocument.mockResolvedValue(false);
    const b = spawnWatched(host);
    b.w.postMessage(req(2));
    await flush();
    expect(deps.createDocument).not.toHaveBeenCalled();
    close.resolve();
    await flush();
    expect(deps.createDocument).toHaveBeenCalledTimes(1);
  });

  it('terminate before connecting never connects and keeps the count right', async () => {
    const { deps, host } = setup();
    const create = deferred();
    deps.createDocument.mockImplementationOnce(() => create.promise);
    const a = spawnWatched(host);
    a.w.postMessage(req(1));
    await flush();
    a.w.terminate();
    create.resolve();
    await flush();
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('a worker that gave up releases its count', async () => {
    const { deps, host } = setup({ script: ['fail', 'fail', 'fail', 'fail', 'fail'] });
    const a = spawnWatched(host);
    a.w.postMessage(req(1));
    await flush();
    expect(a.onerror).toHaveBeenCalledTimes(1);
    deps.hasDocument.mockResolvedValue(true);
    await host.closeIdle();
    expect(deps.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('closeIdle closes a leftover document', async () => {
    const withDoc = setup({ hasDocument: true });
    await withDoc.host.closeIdle();
    expect(withDoc.deps.closeDocument).toHaveBeenCalledTimes(1);
    const without = setup({ hasDocument: false });
    await without.host.closeIdle();
    expect(without.deps.closeDocument).not.toHaveBeenCalled();
  });

  it('closeIdle keeps a document with an open Port', async () => {
    const { deps, host } = setup();
    const { w } = spawnWatched(host);
    w.postMessage(req(1));
    await flush();
    await host.closeIdle();
    expect(deps.closeDocument).not.toHaveBeenCalled();
  });

  it('createDocument failure raises onerror', async () => {
    const { deps, host } = setup();
    deps.createDocument.mockRejectedValueOnce(new Error('blocked'));
    const { w, onerror } = spawnWatched(host);
    w.postMessage(req(1));
    await flush();
    expect(onerror).toHaveBeenCalledWith({ message: 'blocked' });
    expect(deps.connect).not.toHaveBeenCalled();
  });
});
