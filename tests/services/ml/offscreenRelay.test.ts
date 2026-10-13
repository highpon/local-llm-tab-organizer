import { describe, expect, it, vi } from 'vitest';
import { startRelay } from '../../../services/ml/offscreenRelay';
import type { PortLike } from '../../../services/ml/relayProtocol';
import type { MlRequest, MlResponse } from '../../../services/ml/protocol';

class FakeWorker {
  sent: MlRequest[] = [];
  onmessage: ((ev: MessageEvent<MlResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage(msg: MlRequest) { this.sent.push(msg); }
  reply(msg: MlResponse) { this.onmessage?.({ data: msg } as MessageEvent<MlResponse>); }
}

class FakePort implements PortLike {
  sent: unknown[] = [];
  private msgFns: ((m: unknown) => void)[] = [];
  private discFns: (() => void)[] = [];
  constructor(public name = 'ml') {}
  postMessage(msg: unknown) { this.sent.push(msg); }
  onMessage = { addListener: (fn: (m: unknown) => void) => { this.msgFns.push(fn); } };
  onDisconnect = { addListener: (fn: () => void) => { this.discFns.push(fn); } };
  disconnect() {}
  emit(msg: unknown) { this.msgFns.forEach((f) => f(msg)); }
  disconnectFromOtherSide() { this.discFns.forEach((f) => f()); }
}

function setup(spawnImpl?: () => Worker) {
  const workers: FakeWorker[] = [];
  const spawn = vi.fn(spawnImpl ?? (() => {
    const w = new FakeWorker();
    workers.push(w);
    return w as unknown as Worker;
  }));
  let connect!: (port: PortLike) => void;
  startRelay((fn) => { connect = fn; }, spawn);
  return { workers, spawn, connect: (p: PortLike) => connect(p) };
}

describe('startRelay', () => {
  it('every new Port gets relayReady and its own Worker', () => {
    const { connect, spawn } = setup();
    const a = new FakePort();
    const b = new FakePort();
    connect(a);
    connect(b);
    expect(a.sent[0]).toEqual({ type: 'relayReady' });
    expect(b.sent[0]).toEqual({ type: 'relayReady' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('ignores Ports with another name', () => {
    const { connect, spawn } = setup();
    const p = new FakePort('other');
    connect(p);
    expect(spawn).not.toHaveBeenCalled();
    expect(p.sent).toEqual([]);
  });

  it('relays requests to the Worker and responses to the Port', () => {
    const { connect, workers } = setup();
    const p = new FakePort();
    connect(p);
    const req: MlRequest = { id: 1, type: 'embed', texts: ['a'] };
    p.emit(req);
    expect(workers[0]!.sent).toContainEqual(req);
    const res: MlResponse = { id: 1, ok: true, result: [[1]] };
    workers[0]!.reply(res);
    expect(p.sent).toContainEqual(res);
  });

  it('disconnect terminates the Worker', () => {
    const { connect, workers } = setup();
    const p = new FakePort();
    connect(p);
    p.disconnectFromOtherSide();
    expect(workers[0]!.terminate).toHaveBeenCalled();
  });

  it('Worker errors are sent back as workerError', () => {
    const { connect, workers } = setup();
    const p = new FakePort();
    connect(p);
    workers[0]!.onerror?.({ message: 'boom' } as ErrorEvent);
    expect(p.sent).toContainEqual({ type: 'workerError', message: 'boom' });
    workers[0]!.onerror?.({ message: '' } as ErrorEvent);
    expect(p.sent).toContainEqual({ type: 'workerError', message: 'ML worker error' });
  });

  it('spawn failure is sent back as workerError', () => {
    const { connect } = setup(() => { throw new Error('no'); });
    const p = new FakePort();
    connect(p);
    expect(p.sent).toContainEqual({ type: 'workerError', message: 'no' });
  });
});
