export interface ModelSpec { id: string; revision: string; dtype: 'q8' }

/** Multilingual sentence embeddings (384 dimensions). */
export const EMBED_MODEL: ModelSpec = {
  id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
  dtype: 'q8',
};

/** English 1-3 word tab group labels; the model Firefox's own smart tab grouping uses. */
export const TOPIC_MODEL: ModelSpec = {
  id: 'Mozilla/smart-tab-topic',
  revision: '91a6ebc0318de964b0e318c89ba01514746aadb8',
  dtype: 'q8',
};

/** Cache API cache where Transformers.js keeps downloaded model files. */
export const MODEL_CACHE_NAME = 'transformers-cache';
