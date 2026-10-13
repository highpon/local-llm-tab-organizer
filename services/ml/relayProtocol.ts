import type { MlResponse } from './protocol';

// Side-effect-free: imported by both the background and the offscreen relay.
export const ML_PORT = 'ml';

export type RelayMessage = MlResponse | { type: 'relayReady' } | { type: 'workerError'; message: string };

export interface PortLike {
  name: string;
  postMessage(msg: unknown): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
  disconnect(): void;
}
