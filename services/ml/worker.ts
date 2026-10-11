import { env, pipeline, type FeatureExtractionPipeline, type Text2TextGenerationPipeline } from '@huggingface/transformers';
import { EMBED_MODEL, TOPIC_MODEL } from './models';
import type { MlRequest, MlResponse } from './protocol';

env.allowLocalModels = false;
env.useBrowserCache = true;
// Loading the WASM factory through a blob: URL would be blocked by the extension CSP.
env.useWasmCache = false;
const onnxWasm = env.backends.onnx.wasm!;
// Served from the extension itself; nothing comes from a CDN.
onnxWasm.wasmPaths = {
  mjs: new URL('/ort/ort-wasm-simd-threaded.asyncify.mjs', self.location.href).href,
  wasm: new URL('/ort/ort-wasm-simd-threaded.asyncify.wasm', self.location.href).href,
};
// Extension pages are not cross-origin isolated, so no SharedArrayBuffer threads.
onnxWasm.numThreads = 1;

let embedder: FeatureExtractionPipeline | undefined;
let topicGen: Text2TextGenerationPipeline | undefined;

const post = (msg: MlResponse) => self.postMessage(msg);

async function load(): Promise<void> {
  if (embedder && topicGen) return;
  // Sum loaded/total over every file of both models.
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (info: { status: string; file?: string; name?: string; loaded?: number; total?: number }) => {
    if (info.status !== 'progress' || !info.file || !info.total) return;
    files.set(`${info.name}/${info.file}`, { loaded: info.loaded ?? 0, total: info.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    post({ type: 'progress', progress: total > 0 ? loaded / total : 0 });
  };
  [embedder, topicGen] = await Promise.all([
    embedder ?? pipeline('feature-extraction', EMBED_MODEL.id,
      { revision: EMBED_MODEL.revision, dtype: EMBED_MODEL.dtype, progress_callback }),
    topicGen ?? pipeline('text2text-generation', TOPIC_MODEL.id,
      { revision: TOPIC_MODEL.revision, dtype: TOPIC_MODEL.dtype, progress_callback }),
  ]);
}

async function handle(msg: MlRequest): Promise<unknown> {
  switch (msg.type) {
    case 'load':
      await load();
      return null;
    case 'embed': {
      await load();
      if (msg.texts.length === 0) return [];
      return (await embedder!(msg.texts, { pooling: 'mean', normalize: true })).tolist();
    }
    case 'topic': {
      await load();
      const out: string[] = [];
      for (const prompt of msg.prompts) {
        const res = (await topicGen!(prompt, { max_new_tokens: 8 })) as { generated_text: string }[];
        out.push(res[0]?.generated_text ?? '');
      }
      return out;
    }
  }
}

self.onmessage = (ev: MessageEvent<MlRequest>) => {
  const msg = ev.data;
  handle(msg).then(
    (result) => post({ id: msg.id, ok: true, result }),
    (e: unknown) => post({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
};
