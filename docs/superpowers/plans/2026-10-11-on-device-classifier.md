# On-device Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-device tab classifier (bundled Transformers.js, multilingual embeddings + smart-tab-topic naming) and make it the default grouping method.

**Architecture:** A Worker started by the background event page runs Transformers.js and answers `load` / `embed` / `topic` requests. Pure functions in `core/` cluster vectors and name clusters. `services/modelManager.ts` downloads models outside the run lock; `services/onDeviceClassifier.ts` produces `Assignment[]` and falls back to `classifyByDomain` on any failure. The orchestrator picks the classifier from `settings.classifier`.

**Tech Stack:** TypeScript, WXT 0.21 (MV3, Firefox), Vitest with `wxt/testing/fake-browser`, `@huggingface/transformers` 4.3.1 (onnxruntime-web WASM).

**Spec:** `docs/superpowers/specs/2026-10-11-on-device-classifier-design.md`

## Global Constraints

- Firefox minimum stays `140.0`; no new required permissions and no new host permissions
- `data_collection_permissions` stays `{ required: ['none'] }`
- Embedding model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` at revision `2c4055b12046f11709e9df2c122e59ffbdc2f900`, dtype `q8`
- Topic model: `Mozilla/smart-tab-topic` at revision `91a6ebc0318de964b0e318c89ba01514746aadb8`, dtype `q8`, task `text2text-generation`
- Nothing is loaded from a CDN: ONNX Runtime WASM is served from `/ort/` inside the extension; `numThreads = 1`
- CSP: `content_security_policy.extension_pages = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`
- Constants: max 300 tabs per on-device run; 3 anchor tabs per existing group; 60 s inference timeout; 1 h automatic retry back-off; group names cut to 40 characters
- Rejected topic labels (case-insensitive, trimmed): `none`, `adult content`, empty
- Every new or changed UI string goes into both `public/_locales/en/messages.json` and `public/_locales/ja/messages.json` (enforced by `tests/services/i18n.test.ts`)
- Any on-device failure falls back to domain classification for that run; a run never throws because of the classifier
- Commit messages follow the repo style (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. **Event page unloaded mid-download** leaves `modelStatus.state === 'downloading'` forever. A `downloading` status whose `lastAttemptAt` is older than 15 minutes, with no download running in this context, must be treated as restartable (Task 6 test `stale downloading status is restarted`).
2. **Tabs whose title is empty or equals the URL** must still get a non-empty embedding text (the hostname) (Task 3 test `embedText falls back to hostname`).
3. **"Delete downloaded models" while a download is running** must stop the download and end in `missing`, never flip back to `ready` (Task 6 test `delete during download ends missing`).
4. **A cluster whose titles yield no keywords** (all stopwords, symbols or single characters, common in Japanese titles) must be named by domain, never get an empty name (Task 7 test `cluster without keywords is named by domain`).
5. **Unnamed existing groups** (empty title) must not be passed as join targets, otherwise tabs would be assigned the empty name and dropped (Task 8 test `unnamed groups are not join targets`).

---

## File Structure

| File | Responsibility |
|---|---|
| `services/ml/models.ts` (new) | Model ids, revisions, dtypes, cache name. Shared by worker and manager |
| `entrypoints/ml.worker.ts` (new) | Worker: Transformers.js setup and `load` / `embed` / `topic` handlers |
| `services/ml/protocol.ts` (new) | Request/response/progress message types between client and worker |
| `services/ml/client.ts` (new) | `MlClient`: promise wrapper around the Worker with timeout and terminate |
| `core/nameCluster.ts` (new) | Embedding text, tokenizing, c-TF-IDF keywords, Latin detection, topic prompt, label acceptance |
| `core/clusterTabs.ts` (new) | Cosine, joining existing groups, agglomerative clustering, thresholds |
| `tests/fixtures/embeddings.json` (new) + `scripts/embed-fixture.mjs` (new) | Real-model vectors for threshold tests |
| `services/modelManager.ts` (new) | `modelStatus` storage, download, back-off, deletion, error notification |
| `services/onDeviceClassifier.ts` (new) | `classifyOnDevice` |
| `core/types.ts`, `services/settings.ts`, `services/llmClassifier.ts`, `services/orchestrator.ts`, `services/runHistory.ts`, `services/scheduler.ts`, `entrypoints/background.ts` | Wiring and settings migration |
| `entrypoints/options/*`, `entrypoints/popup/*`, `public/_locales/*` | UI |
| `wxt.config.ts`, `package.json` | Dependency, CSP, copying ORT WASM to `/ort/` |

---

### Task 1: Runtime feasibility — worker, client and bundled runtime

This task decides whether the design holds (spec §8, manual checks 1–3). If any manual check in Step 7 fails, **stop and report to the user** instead of continuing.

**Files:**
- Create: `services/ml/models.ts`, `services/ml/protocol.ts`, `services/ml/client.ts`, `entrypoints/ml.worker.ts`
- Modify: `package.json`, `wxt.config.ts`
- Test: `tests/services/ml/client.test.ts`

**Interfaces:**
- Produces:
  - `services/ml/models.ts`: `EMBED_MODEL = { id, revision, dtype: 'q8' }`, `TOPIC_MODEL = { id, revision, dtype: 'q8' }` (values from Global Constraints), `MODEL_CACHE_NAME = 'transformers-cache'`
  - `services/ml/protocol.ts`:
    ```ts
    export type MlRequest =
      | { id: number; type: 'load' }
      | { id: number; type: 'embed'; texts: string[] }
      | { id: number; type: 'topic'; prompts: string[] };
    export type MlResponse =
      | { id: number; ok: true; result: unknown }
      | { id: number; ok: false; error: string }
      | { type: 'progress'; progress: number }; // 0..1, aggregated over all model files
    ```
  - `services/ml/client.ts`:
    ```ts
    export interface MlClient {
      load(onProgress?: (progress: number) => void): Promise<void>;
      embed(texts: string[]): Promise<number[][]>;   // mean-pooled, L2-normalized
      topic(prompts: string[]): Promise<string[]>;   // one generated_text per prompt
      terminate(): void;
    }
    export function createMlClient(spawn?: () => Worker): MlClient;
    ```

- [ ] **Step 1: Add the dependency**

Run: `npm install @huggingface/transformers@4.3.1`
Expected: `package.json` lists it under `dependencies`.

- [ ] **Step 2: Write the failing client tests** in `tests/services/ml/client.test.ts`, using a fake Worker object (`postMessage` records requests; the test calls its `onmessage` with responses):
  - `load forwards progress and resolves on ok` — progress messages `0.5`, `1` reach `onProgress` in order; the `{ id, ok: true }` response resolves `load()`
  - `embed resolves with the result of the matching id` — two concurrent `embed` calls answered out of order each get their own result
  - `a failed response rejects with the error text` — `{ ok: false, error: 'boom' }` rejects with an `Error` whose message is `boom`
  - `terminate rejects pending requests` — after `terminate()`, a pending `embed` rejects and the fake worker's `terminate` was called once
  - `worker error event rejects pending requests` — calling the fake's `onerror` rejects all pending calls

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/services/ml/client.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `models.ts`, `protocol.ts` and `client.ts`**

The client assigns increasing ids, keeps a `Map<id, {resolve, reject}>`, and routes `progress` messages to the active `load` callback. The default `spawn` creates the worker from `entrypoints/ml.worker.ts` (see Step 5 for how it is built).

- [ ] **Step 5: Implement `entrypoints/ml.worker.ts` and bundling**
  - Worker setup: `env.allowLocalModels = false`, `env.useBrowserCache = true`, `env.backends.onnx.wasm.wasmPaths = new URL('/ort/', self.location.href).href`, `env.backends.onnx.wasm.numThreads = 1`
  - `load`: create `pipeline('feature-extraction', EMBED_MODEL.id, { revision, dtype })` and `pipeline('text2text-generation', TOPIC_MODEL.id, { revision, dtype })` once (cached in module variables), with a `progress_callback` that sums `loaded / total` over files and posts `{ type: 'progress' }`
  - `embed`: `(await extractor(texts, { pooling: 'mean', normalize: true })).tolist()`
  - `topic`: for each prompt, `generator(prompt, { max_new_tokens: 8 })[0].generated_text`
  - Bundling: first try Vite's worker import in `client.ts` (`new Worker(new URL('../../entrypoints/ml.worker.ts', import.meta.url), { type: 'module' })`). If WXT's background build does not emit it, register the worker as an unlisted script entrypoint (`entrypoints/ml-worker.ts` with `defineUnlistedScript`) and spawn it with `new Worker(browser.runtime.getURL('/ml-worker.js'))`. Record which one worked in the commit message
  - `wxt.config.ts`: add the CSP from Global Constraints, and a `hooks['build:publicAssets']` entry that copies every `ort-wasm-simd-threaded*.wasm` and `ort-wasm-simd-threaded*.mjs` from the `onnxruntime-web/dist` directory that `@huggingface/transformers` resolves to into `ort/`

- [ ] **Step 6: Run the tests, type check and build**

Run: `npx vitest run tests/services/ml/client.test.ts && npm run compile && npm run build:firefox`
Expected: tests PASS, no type errors, `.output/firefox-mv3/ort/` contains the WASM files, and the manifest contains the CSP.

- [ ] **Step 7: Manual feasibility checks (fresh Firefox profile, `npm run dev:firefox`)**

Temporarily add `(globalThis as any).__ml = createMlClient;` to `entrypoints/background.ts` (do not commit it), then in the background page console (`about:debugging` → Inspect) run:
```js
const c = __ml();
await c.load(p => console.log('progress', p));
console.log(await c.embed(['GitHub pull requests', 'GitHub のプルリクエスト']));
console.log(await c.topic(['Topic from keywords: dogs,food,pets. titles: \nDogs - Google Search\nDog Food - Shopping']));
c.terminate();
```
Pass criteria (all three):
1. `load` reports progress and finishes; `embed` returns two 384-length arrays; the network panel shows no request to a CDN
2. No host permission was added or requested; requests to huggingface.co (and redirects) succeed
3. `topic` returns a short English label (e.g. `Dogs`)

Then restart Firefox with the same profile (`web-ext run --keep-profile-changes --profile-create-if-missing -p <dir>` or a temporary add-on in a persistent profile) and run `load` again: it must finish without downloading model files (network panel shows no model GETs).

If any check fails: stop, write down what failed, and report to the user.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json wxt.config.ts services/ml entrypoints/ml.worker.ts tests/services/ml
git commit -m "feat: add the on-device ML worker and client"
```

---

### Task 2: Types and settings migration

**Files:**
- Modify: `core/types.ts`, `services/settings.ts`, `services/llmClassifier.ts`, `entrypoints/options/main.ts` (only the `listModels` call that passes `enabled`)
- Test: `tests/services/settings.test.ts`, `tests/services/llmClassifier.test.ts`

**Interfaces:**
- Produces:
  - `core/types.ts`: `ClassifyMethod = 'llm' | 'onDevice' | 'domain' | 'mixed'`; `OnDeviceErrorKind = 'modelNotReady' | 'modelDownloadFailed' | 'inferenceFailed'`; `ClassifyErrorKind = LlmErrorKind | OnDeviceErrorKind`; `ExistingGroup = { title: string; tabs: TabInfo[] }`
  - `services/settings.ts`: `ClassifierKind = 'onDevice' | 'llm' | 'domain'`; `Settings.classifier: ClassifierKind`; `Settings.llm = { baseUrl; model; timeoutSeconds }` (no `enabled`); `DEFAULT_SETTINGS.classifier = 'onDevice'`
  - `services/llmClassifier.ts`: `ClassifyResult = { assignments: Assignment[]; method: ClassifyMethod; error?: ClassifyErrorKind }`; `classifyTabs` no longer checks `cfg.enabled` (the caller decides)

- [ ] **Step 1: Write the failing tests**
  - `settings.test.ts`:
    - `defaults to onDevice` — empty storage → `classifier === 'onDevice'`
    - `migrates llm.enabled true to llm` — stored `{ llm: { enabled: true, baseUrl: 'http://h/v1', model: 'm', timeoutSeconds: 9 } }` → `classifier === 'llm'`, other llm fields kept, and the result has no `llm.enabled`
    - `migrates llm.enabled false to onDevice`
    - `keeps a stored classifier over llm.enabled` — `{ classifier: 'domain', llm: { enabled: true } }` → `'domain'`
    - `rejects an unknown classifier` — `{ classifier: 'x' }` → `'onDevice'`
  - `llmClassifier.test.ts`: update `cfg` to drop `enabled`; delete the test for the disabled path

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/services/settings.test.ts tests/services/llmClassifier.test.ts`
Expected: FAIL on the new migration tests.

- [ ] **Step 3: Implement the types, `mergeSettings` migration and the `classifyTabs` change**; fix the compile errors this causes in `orchestrator.ts` minimally (`settings.llm.enabled` → `settings.classifier === 'llm'`) and in `entrypoints/options/main.ts` (`listModels` no longer takes `enabled`; the LLM checkbox becomes `classifier === 'llm'` until Task 9 replaces the UI)

- [ ] **Step 4: Run the whole suite and type check**

Run: `npm test && npm run compile`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat: replace llm.enabled with a classifier setting`

---

### Task 3: Naming helpers (`core/nameCluster.ts`)

**Files:**
- Create: `core/nameCluster.ts`
- Modify: `services/llmClassifier.ts` (use `clipGroupName` instead of its local 40-character cut)
- Test: `tests/core/nameCluster.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function stripSiteSuffix(title: string): string;
  export function embedText(tab: TabInfo): string;              // `${stripSiteSuffix(title)} ${hostname}`, trimmed; hostname alone when the title is empty or equals the URL
  export function tokenize(text: string): string[];             // Intl.Segmenter word-like, lower-cased, filtered
  export function clusterKeywords(clusters: string[][], n: number): string[][]; // titles per cluster → top n terms per cluster
  export function isMostlyLatin(titles: string[]): boolean;
  export function topicPrompt(keywords: string[], titles: string[]): string;
  export function acceptLabel(raw: string): string | null;      // trimmed + clipped, or null if rejected
  export function clipGroupName(name: string): string;          // trim, cut to 40 code points, trim
  ```

- [ ] **Step 1: Write the failing tests**
  - `stripSiteSuffix`: `'Pull requests · foo/bar - GitHub'` → `'Pull requests · foo/bar'`; `'News | BBC'` → `'News'`; `'A — B — C'` → `'A — B'`; `'- GitHub'` → `'- GitHub'` (nothing left before the separator, keep)
  - `embedText falls back to hostname` — title `''` and title equal to the URL both give `'github.com'` for `https://github.com/x`; a normal tab gives `'Pull requests github.com'`
  - `tokenize`: `'Dogs and Dog Food 2024'` → `['dogs', 'dog', 'food']` (`and` is a stopword, number dropped); `'東京の天気予報'` contains `'東京'` and `'天気'` and no single-character token
  - `clusterKeywords`: with clusters `[['Dog food', 'Dog toys'], ['Cat food']]` and `n = 1`, cluster 0 → `['dog']`, cluster 1 → `['cat']` (shared `food` scores lower); a cluster of only stopwords → `[]`
  - `isMostlyLatin`: `['Dogs', 'Cats']` → true; `['犬の餌', '猫']` → false; `['Dogs', '犬', '猫']` → false (strict majority of titles must be mostly Latin letters)
  - `topicPrompt(['dogs','food','pets'], ['A','B','C','D'])` → `'Topic from keywords: dogs,food,pets. titles: \nA\nB\nC'` (max 3 titles); with no keywords → `'Topic from keywords: . titles: \nA'`
  - `acceptLabel`: `' None '`, `'Adult Content'`, `''` → `null`; `'Dogs'` → `'Dogs'`; a 50-character label → 40 characters
  - `clipGroupName` keeps surrogate pairs intact

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/core/nameCluster.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `core/nameCluster.ts`**

c-TF-IDF per spec §4: for term `t` in cluster `c`, `score = tf(t, c) * Math.log(1 + avgWordsPerCluster / tfAll(t))`; ties broken by first occurrence. Stopwords: a short built-in list (English articles, conjunctions, prepositions, `the`, `and`, `of`, `for`, `to`, `in`, `on`, `with`, `a`, `an`, `is`, `how`, `what`; Japanese `する`, `こと`, `もの`, `ため`, `これ`, `それ`, `よう`, `さん`) plus a few generic web words (`home`, `page`, `login`, `ログイン`, `トップ`). A title is "mostly Latin" when Latin letters are more than half of its letters (`\p{L}`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/nameCluster.test.ts tests/services/llmClassifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat: add cluster naming helpers`

---

### Task 4: Clustering (`core/clusterTabs.ts`)

**Files:**
- Create: `core/clusterTabs.ts`
- Test: `tests/core/clusterTabs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAX_ON_DEVICE_TABS = 300;
  export const ANCHORS_PER_GROUP = 3;
  export const JOIN_THRESHOLD = 0.6;     // placeholder; Task 5 sets the final value
  export const CLUSTER_THRESHOLD = 0.5;  // max average cosine distance to merge; placeholder; Task 5 sets the final value
  export function cosine(a: number[], b: number[]): number;
  /** Per vector: index of the best group whose max anchor similarity > threshold, else -1. */
  export function joinExisting(vectors: number[][], groupAnchors: number[][][], threshold: number): number[];
  /** Average-linkage agglomerative clustering; returns clusters as index lists, ordered by smallest index. */
  export function agglomerate(vectors: number[][], maxDistance: number): number[][];
  ```

- [ ] **Step 1: Write the failing tests** with small hand-made unit vectors:
  - `cosine` of identical vectors is 1, orthogonal 0
  - `joinExisting`: a vector at similarity 0.9 to group 1's second anchor and 0.7 to group 0 → `1`; a vector whose best similarity equals the threshold exactly → `-1` (strictly greater); no groups → all `-1`
  - `agglomerate`: three near-identical vectors plus one orthogonal → `[[0,1,2],[3]]`; average linkage — two tight pairs whose cross distance averages above `maxDistance` stay separate even if one cross pair is close; empty input → `[]`

- [ ] **Step 2: Run them to verify they fail** — `npx vitest run tests/core/clusterTabs.test.ts`, expected FAIL

- [ ] **Step 3: Implement** — `agglomerate` is the O(n³) textbook version (n ≤ 300): start with singletons, repeatedly merge the pair with the smallest average distance `1 - cosine` while it is `<= maxDistance`

- [ ] **Step 4: Run tests** — expected PASS

- [ ] **Step 5: Commit** — `feat: add tab clustering`

---

### Task 5: Threshold fixture

**Files:**
- Create: `scripts/embed-fixture.mjs`, `tests/fixtures/embeddings.json`, `tests/core/thresholds.test.ts`
- Modify: `core/clusterTabs.ts` (final `JOIN_THRESHOLD`, `CLUSTER_THRESHOLD`)

**Interfaces:**
- Consumes: `EMBED_MODEL` (Task 1), `embedText` (Task 3), `joinExisting`, `agglomerate` (Task 4)
- Produces: `tests/fixtures/embeddings.json` = `{ model: string; revision: string; items: { text: string; topic: string; vector: number[] }[] }`

- [ ] **Step 1: Write the fixture script** `scripts/embed-fixture.mjs` (Node, `@huggingface/transformers`, same model/revision/dtype/pooling as the worker). It embeds a hard-coded list of about 40 tab texts (already in `embedText` form) labelled with a `topic`: at least 5 topics, each with English-only, Japanese-only and mixed members (e.g. GitHub PRs, cooking recipes, Japanese train timetables, TypeScript docs, travel booking), plus 4 unrelated singletons with unique topics. Vectors are rounded to 4 decimals.

- [ ] **Step 2: Generate the fixture**

Run: `node scripts/embed-fixture.mjs > tests/fixtures/embeddings.json`
Expected: the file exists with every vector of length 384.

- [ ] **Step 3: Write `tests/core/thresholds.test.ts`**
  - `clusters match topics` — `agglomerate(vectors, CLUSTER_THRESHOLD)` gives a purity ≥ 0.9 (fraction of items whose cluster's majority topic equals their own), and no cluster mixes two non-singleton topics
  - `English and Japanese members of a topic cluster together` — for each topic, its English and Japanese items share a cluster
  - `singletons stay alone` — each unrelated singleton is alone in its cluster
  - `join works across languages` — using the first 3 items of each topic as anchors, every other item of that topic joins its own topic with `JOIN_THRESHOLD`, and singletons join nothing

- [ ] **Step 4: Tune** — sweep `CLUSTER_THRESHOLD` and `JOIN_THRESHOLD` in steps of 0.05 (a throwaway loop, not committed) and pick the middle of the passing range for each. Write the values into `core/clusterTabs.ts` with a one-line comment naming the fixture

- [ ] **Step 5: Run tests** — `npx vitest run tests/core` expected PASS

- [ ] **Step 6: Commit** — `test: pick clustering thresholds from a real-model fixture`

---

### Task 6: Model manager

**Files:**
- Create: `services/modelManager.ts`, `services/keepAlive.ts`
- Modify: `services/orchestrator.ts` (import `whileKeepingAlive` from `keepAlive.ts`), `public/_locales/en/messages.json`, `public/_locales/ja/messages.json` (add `notifyModelFailed`; en: "Could not download the on-device AI models. Tabs are grouped by domain until it succeeds.")
- Test: `tests/services/modelManager.test.ts`

**Interfaces:**
- Consumes: `MlClient`, `createMlClient` (Task 1), `MODEL_CACHE_NAME` (Task 1)
- Produces:
  ```ts
  export type ModelState = 'missing' | 'downloading' | 'ready' | 'error';
  export interface ModelStatus { state: ModelState; progress?: number; error?: string; lastAttemptAt?: number }
  export const MODEL_STATUS_KEY = 'modelStatus';
  export interface ModelDeps { client: () => MlClient; notify: (message: string) => Promise<void>; now: () => number; deleteCache: () => Promise<void> }
  export function loadModelStatus(): Promise<ModelStatus>;           // default { state: 'missing' }
  /** Starts a download unless one runs, the models are ready, or the back-off applies (force skips the back-off). Resolves when it ends. */
  export function ensureModels(opts?: { force?: boolean }, deps?: Partial<ModelDeps>): Promise<void>;
  export function deleteModels(deps?: Partial<ModelDeps>): Promise<void>;
  /** Marks the cache unusable after a load failure on ready models: deletes it, state → missing. */
  export function invalidateModels(deps?: Partial<ModelDeps>): Promise<void>;
  ```
  Default `deleteCache` is `caches.delete(MODEL_CACHE_NAME)`; default `notify` creates the `tab-tidy-model` notification with `t('notifyModelFailed')`.

- [ ] **Step 1: Write the failing tests** (fake browser storage, mocked client, fake `now`):
  - `downloads from missing to ready` — state goes `downloading` (with `lastAttemptAt = now`) → progress values stored → `ready`; the client is terminated afterwards
  - `concurrent calls share one download` — two `ensureModels()` calls create one client
  - `failure sets error and notifies once` — failing `load` → `{ state: 'error', error: <message> }`, `notify` called once; a second failure later does not notify again
  - `back-off` — in `error` with `lastAttemptAt = now - 59 min`: no download; at `now - 61 min`: downloads; `force: true` downloads at once
  - `ready is left alone` — no client created
  - `stale downloading status is restarted` — stored `downloading` with `lastAttemptAt = now - 16 min` and no download in this context → downloads; at `now - 14 min` → does nothing
  - `delete during download ends missing` — `deleteModels()` while `load` is pending terminates the client, calls `deleteCache`, and the final state is `missing` even after the pending `load` settles
  - `invalidateModels deletes the cache and sets missing`

- [ ] **Step 2: Run them to verify they fail** — `npx vitest run tests/services/modelManager.test.ts`, expected FAIL

- [ ] **Step 3: Implement** — keep the running download in a module-level `{ client, promise, cancelled }`; write progress to storage at most once per percentage point; keep the event page alive during the download with the same 20 s `getPlatformInfo` interval as `orchestrator.ts` (move `whileKeepingAlive` into `services/keepAlive.ts` and import it from both)

- [ ] **Step 4: Run tests** — `npm test` expected PASS

- [ ] **Step 5: Commit** — `feat: add the model manager`

---

### Task 7: On-device classifier

**Files:**
- Create: `services/onDeviceClassifier.ts`
- Test: `tests/services/onDeviceClassifier.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 6; `classifyByDomain`, `domainKey` from `core/classifyByDomain.ts`
- Produces:
  ```ts
  export interface OnDeviceDeps {
    client: () => MlClient;
    status: () => Promise<ModelStatus>;
    ensure: () => void;                 // fire-and-forget ensureModels()
    invalidate: () => Promise<void>;
    timeoutMs: number;                  // 60_000
  }
  export function classifyOnDevice(tabs: TabInfo[], existing: ExistingGroup[], deps?: Partial<OnDeviceDeps>): Promise<ClassifyResult>;
  ```

- [ ] **Step 1: Write the failing tests** (mocked client returning chosen vectors; `topic` mocked):
  - `not ready: domain fallback and download started` — status `missing` → `method: 'domain'`, `error: 'modelNotReady'`, `ensure` called once, no client created; status `downloading` → same, `ensure` called (it no-ops itself)
  - `joins an existing group` — a candidate close to an anchor gets the group's exact title
  - `clusters and names with the topic model` — two Latin-titled tabs with close vectors → both get the topic label; the prompt equals `topicPrompt(top 3 keywords, titles)`
  - `Japanese cluster is named by keywords` — `topic` is not called for it
  - `rejected label falls back to keywords` — topic returns `'None'`
  - `cluster without keywords is named by domain` — titles `['・', '!!']` on the same domain → the domain display name
  - `singletons use domain classification` and the result `method` stays `'onDevice'`
  - `over 300 tabs: the rest use domain` — 302 candidates → the last 2 get domain names and `method === 'mixed'`
  - `inference error: domain fallback` — `embed` rejects → `method: 'domain'`, `error: 'inferenceFailed'`, client terminated
  - `load failure on ready models invalidates the cache` — `load` rejects while status is `ready` → `invalidate` called, `error: 'inferenceFailed'`
  - `timeout: domain fallback` — fake timers, `embed` never resolves, advance 60 s → `inferenceFailed`, client terminated
  - `the client is always terminated` — success and failure paths both

- [ ] **Step 2: Run them to verify they fail** — expected FAIL

- [ ] **Step 3: Implement** — flow of spec §4: one `client.load()` + one `embed` call for all candidate texts and all anchor texts (group title + first `ANCHORS_PER_GROUP` tabs' `embedText`), one `topic` call for all Latin clusters; the whole thing under one `timeoutMs` race; `finally { client.terminate() }`. Names go through `clipGroupName` / `acceptLabel`

- [ ] **Step 4: Run tests** — `npm test` expected PASS

- [ ] **Step 5: Commit** — `feat: classify tabs on device`

---

### Task 8: Orchestrator and background wiring

**Files:**
- Modify: `services/orchestrator.ts`, `services/runHistory.ts`, `services/scheduler.ts`, `entrypoints/background.ts`
- Test: `tests/services/orchestrator.test.ts`

**Interfaces:**
- Consumes: `classifyOnDevice` (Task 7), `classifyTabs` (Task 2), `ensureModels`, `deleteModels` (Task 6)
- Produces:
  - `RunDeps.classify: (tabs: TabInfo[], existing: ExistingGroup[], settings: Settings) => Promise<ClassifyResult>`; the default dispatches on `settings.classifier` (`'llm'` → `classifyTabs(tabs, existing.map(g => g.title), settings.llm)`, `'onDevice'` → `classifyOnDevice`, `'domain'` → `{ assignments: classifyByDomain(tabs), method: 'domain' }`)
  - `RunRecord.classifyError?: ClassifyErrorKind`
  - `Message` gains `{ type: 'downloadModels' }` and `{ type: 'deleteModels' }`; background handles them with `ensureModels({ force: true })` (not awaited by the response) and `deleteModels()`

- [ ] **Step 1: Write/adjust the failing tests**
  - Update `makeDeps.classify` to the new signature
  - `passes existing groups with their tabs` — snapshot with group 50 `'Existing'` holding tabs 5, 6, 7, 8 → `classify` receives `[{ title: 'Existing', tabs: [5, 6, 7, 8 as TabInfo] }]` (all tabs; the classifier picks anchors)
  - `unnamed groups are not join targets` — a group with title `''` is not in `existing`
  - `same-titled groups in two windows are merged into one entry`
  - `records the classify error` — classify returns `error: 'modelNotReady'` → `record.classifyError === 'modelNotReady'`
  - `LLM status only for the llm classifier` — with `classifier: 'onDevice'`, `llmStatus` is removed from storage and `updateLlmStatus` does not notify

- [ ] **Step 2: Run them to verify they fail** — `npx vitest run tests/services/orchestrator.test.ts`, expected FAIL

- [ ] **Step 3: Implement** the dispatch, `classifyError` recording and the background messages (add both types to the `known` list)

- [ ] **Step 4: Run tests and type check** — `npm test && npm run compile` expected PASS

- [ ] **Step 5: Commit** — `feat: choose the classifier per settings and wire model messages`

---

### Task 9: Settings page, popup and locales

**Files:**
- Modify: `entrypoints/options/index.html`, `entrypoints/options/main.ts`, `entrypoints/popup/index.html`, `entrypoints/popup/main.ts`, `public/_locales/en/messages.json`, `public/_locales/ja/messages.json`
- Test: `tests/services/i18n.test.ts` (existing; must keep passing)

**Interfaces:**
- Consumes: `Settings.classifier` (Task 2), `loadModelStatus`, `MODEL_STATUS_KEY` (Task 6), `RunRecord.classifyError` (Task 8), messages `downloadModels` / `deleteModels` (Task 8)

- [ ] **Step 1: Settings page** (spec §6)
  - Replace the LLM fieldset with a "Classification method" fieldset: radios `classifier` = `onDevice` / `llm` / `domain`
  - Under on-device: status line, "Download now" (`downloadModels` message), "Delete downloaded models" (`deleteModels`, disabled unless state is `ready` or `error`), and the note text
  - LLM fields are disabled unless `llm` is selected; the save handler requests the host permission only when `llm` is selected (keep the request as the first `await` in the handler)
  - Subscribe to `browser.storage.onChanged` for `MODEL_STATUS_KEY` and re-render the status
  - History: `methodOnDevice` label; notes column shows `classifyError` text when there is no `error`
- [ ] **Step 2: Popup** — the `llmStatusHeading` section becomes "Classification status": model status for `onDevice` (with the open-settings link on `error`), current LLM text for `llm`, `classifyByDomainStatus` text for `domain`
- [ ] **Step 3: Locales** — add en/ja for every new key, including at least (`notifyModelFailed` already exists from Task 6): `classifierLegend`, `classifierOnDevice`, `classifierLlm`, `classifierDomain`, `onDeviceNote` (en: "Downloads about 175 MB from huggingface.co once. Tab data is never sent."), `modelMissing`, `modelDownloading` (with a percent placeholder), `modelReady`, `modelError` (with a reason placeholder), `downloadModels`, `deleteModels`, `methodOnDevice`, `classifyStatusHeading`, `classifyByDomainStatus`, `noteModelNotReady`, `noteModelDownloadFailed`, `noteInferenceFailed`. Remove keys that are no longer referenced (`llmLegend`, `llmEnabledLabel`, `llmStatusHeading` if unused)
- [ ] **Step 4: Run tests, type check and build** — `npm test && npm run compile && npm run build:firefox` expected PASS
- [ ] **Step 5: Manual check** — in `npm run dev:firefox`: switching radios enables/disables the LLM fields; "Download now" shows live progress then "ready"; "Delete downloaded models" returns to "missing"; the popup shows the same status; both en and ja UI (`intl.locale.requested`)
- [ ] **Step 6: Commit** — `feat: add the classification method UI`

---

### Task 10: Documentation and release checks

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-10-11-tab-organizer-design.md`, `docs/manual-test.md`, `package.json` (`description`)

- [ ] **Step 1: Update docs**
  - README: feature list says grouping is content-based on device by default (one-time ~175 MB download from huggingface.co, tab data never sent), with the LLM server and domain as alternatives; Ollama section is framed as optional
  - Main spec: privacy section mentions the model download; remove "Running the LLM inside the browser" from out of scope and link the on-device spec; settings table gets `classifier`
  - `docs/manual-test.md`: add the manual tests from the on-device spec §8 (including the Task 1 checks)
- [ ] **Step 2: Release checks**

Run: `npm test && npm run compile && npm run build:firefox && npx web-ext lint -s .output/firefox-mv3`
Expected: all pass; `web-ext lint` reports no errors (warnings about bundled minified code or WASM are written down in `docs/manual-test.md` if they appear).
- [ ] **Step 3: Run the manual checklist additions** on a fresh profile and record results in `docs/manual-test.md`
- [ ] **Step 4: Commit** — `docs: document the on-device classifier`
