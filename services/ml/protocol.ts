export type MlRequest =
  | { id: number; type: 'load'; remote: boolean } // remote: false = cached models only
  | { id: number; type: 'embed'; texts: string[] }
  | { id: number; type: 'topic'; prompts: string[] };

export type MlResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { type: 'progress'; progress: number }; // 0..1, aggregated over all model files
