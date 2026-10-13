import type { MlRequest, MlResponse } from './protocol';
import { ML_PORT, type PortLike, type RelayMessage } from './relayProtocol';

function spawnWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

/** Offscreen side of the Chrome ML transport: one Worker per connected Port. */
export function startRelay(
  onConnect: (fn: (port: PortLike) => void) => void,
  spawn: () => Worker = spawnWorker,
): void {
  onConnect((port) => {
    if (port.name !== ML_PORT) return;
    const send = (msg: RelayMessage) => port.postMessage(msg);
    send({ type: 'relayReady' });
    let worker: Worker;
    try {
      worker = spawn();
    } catch (e) {
      send({ type: 'workerError', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    worker.onmessage = (ev) => send(ev.data as MlResponse);
    worker.onerror = (ev) => send({ type: 'workerError', message: ev.message || 'ML worker error' });
    port.onMessage.addListener((msg) => worker.postMessage(msg as MlRequest));
    port.onDisconnect.addListener(() => worker.terminate());
  });
}
