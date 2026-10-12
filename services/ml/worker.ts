import { env, pipeline, type FeatureExtractionPipeline, type Text2TextGenerationPipeline } from '@huggingface/transformers';
import { EMBED_MODEL, MODEL_CACHE_NAME, TOPIC_MODEL } from './models';
import type { MlRequest, MlResponse } from './protocol';

env.allowLocalModels = false;
env.useBrowserCache = true;
const defaultFetch = env.fetch;
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

const PINNED = [EMBED_MODEL, TOPIC_MODEL];

/**
 * fetch for a cached-only load: answers from the model cache and never touches the network, so a
 * missing required file fails the load (a missing optional file is skipped, as on download).
 * Transformers.js 4.3.1 looks up tokenizer_config.json at revision "main" even when a revision is
 * pinned; that URL is answered with the pinned revision's cached file.
 */
async function cachedOnlyFetch(input: string | URL): Promise<Response> {
  const url = String(input);
  const cache = await caches.open(MODEL_CACHE_NAME);
  const model = PINNED.find((m) => url.startsWith(`https://huggingface.co/${m.id}/resolve/main/`));
  const key = model ? url.replace('/resolve/main/', `/resolve/${model.revision}/`) : url;
  return (await cache.match(key)) ?? new Response(null, { status: 404 });
}

let embedder: FeatureExtractionPipeline | undefined;
let topicGen: Text2TextGenerationPipeline | undefined;

const post = (msg: MlResponse) => self.postMessage(msg);

async function load(remote: boolean): Promise<void> {
  if (embedder && topicGen) return;
  env.fetch = remote ? defaultFetch : cachedOnlyFetch;
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
      await load(msg.remote);
      return null;
    case 'embed': {
      await load(false);
      if (msg.texts.length === 0) return [];
      return (await embedder!(msg.texts, { pooling: 'mean', normalize: true })).tolist();
    }
    case 'topic': {
      await load(false);
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
