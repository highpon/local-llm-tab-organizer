# On-device Classifier Design

- Date: 2026-10-11
- Status: awaiting review
- Builds on: [`2026-10-11-tab-organizer-design.md`](2026-10-11-tab-organizer-design.md)

## 1. Purpose

Make content-based tab grouping work right after installation, with no setup. Today content-based grouping needs a local LLM server (Ollama etc., plus `OLLAMA_ORIGINS`), which most users will never configure. This design adds an on-device classifier that runs inside the extension and becomes the default.

### Success criteria

- On a fresh install with default settings, grouping becomes content-based after a one-time model download, with no user action
- English and Japanese tabs are both clustered by content; groups get readable names in either language
- Tab titles and URLs never leave the device in on-device mode; the only network traffic is fetching model files
- The run never fails because of the classifier: any on-device failure falls back to domain classification for that run
- Existing users who enabled the LLM server keep their current behaviour

## 2. Summary of decisions

| Item | Decision |
|---|---|
| Inference runtime | Transformers.js (`@huggingface/transformers`) with onnxruntime-web WASM, **bundled in the extension**. Firefox's `browser.trial.ml` was rejected: it is disabled by default in Beta/Release (needs `about:config` changes), which defeats the "no setup" goal |
| Approach | Hybrid: an embedding model clusters tabs; a small text2text model names clusters, with a keyword-based fallback |
| Embedding model | `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, q8 (~118 MB), multilingual |
| Naming model | `Mozilla/smart-tab-topic`, q8 encoder + merged decoder (~57 MB), English only (the model Firefox's own smart tab grouping uses) |
| Naming for non-Latin clusters | Keywords extracted with `Intl.Segmenter` + c-TF-IDF; then domain name |
| Where inference runs | A dedicated Worker started by the background event page; terminated after every run |
| Model download | Decoupled from the run. If models are not ready, the run uses domain classification and starts the download in the background |
| Classifier choice | Setting `classifier: 'onDevice' \| 'llm' \| 'domain'`, default `'onDevice'` |
| Host permissions | None added (Hugging Face serves CORS). Verified first during implementation |
| Model revisions | Pinned to commit hashes |

## 3. Architecture

### New files

```
core/
  clusterTabs.ts        Average-linkage agglomerative clustering (cosine-distance threshold)
                        and assignment of tabs to existing groups. Pure functions
  nameCluster.ts        Keyword extraction (Intl.Segmenter + c-TF-IDF), topic-model prompt
                        building, label filtering, Latin-script detection. Pure functions
services/
  onDeviceClassifier.ts Same entry shape as classifyTabs. Talks to the Worker, falls back
                        to classifyByDomain
  modelManager.ts       Model status (missing / downloading / ready / error), background
                        download, retry back-off, deletion
entrypoints/
  ml.worker.ts          Loads Transformers.js. Exposes only embed(texts) and topic(prompt)
public/ort/             onnxruntime-web WASM files, served from the extension
```

### Changes to existing code

- **Settings**: replace `llm.enabled` with `classifier: 'onDevice' | 'llm' | 'domain'` (default `'onDevice'`). The other `llm.*` fields stay. Migration in `mergeSettings`: if `classifier` is absent, stored `llm.enabled: true` maps to `'llm'`, anything else to `'onDevice'`
- **`RunDeps.classify`**: the second argument changes from existing group names (`string[]`) to existing groups `{ title: string; tabs: TabInfo[] }[]` (non-empty titles, merged by title). The LLM classifier uses only the titles, so its behaviour is unchanged
- **Orchestrator**: picks the classifier from `settings.classifier`; `updateLlmStatus` runs only for `'llm'`; on-device status is reported through `modelStatus` (section 5)
- **Types**: `ClassifyMethod` gains `'onDevice'`. A new `OnDeviceErrorKind = 'modelNotReady' | 'modelDownloadFailed' | 'inferenceFailed'`, separate from `LlmErrorKind`. `ClassifyResult.error` becomes `LlmErrorKind | OnDeviceErrorKind`
- **Manifest** (`wxt.config.ts`): add `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`
- `planGrouping`, `tabsAdapter`, pending suggestions and undo are unchanged: the on-device classifier produces `Assignment[]` like the others

## 4. Classification flow (one run, on-device)

1. **Check models.** If `modelStatus` is not `ready`, start the download (not awaited, so it runs outside the run lock), classify all candidates by domain, and return `method: 'domain'`, `error: 'modelNotReady'`
2. **Cap.** Process at most 300 candidate tabs (Firefox's own limit); the rest are classified by domain
3. **Embed.** For each candidate, embed `"<title without site suffix> <hostname>"`. Site suffixes are the part after the last ` - `, ` | ` or ` — ` when what remains is non-empty. For each existing group, embed the group title and its first 3 tabs as anchors (as Firefox does)
4. **Join existing groups.** A candidate joins the existing group whose anchors give the highest maximum cosine similarity, if that similarity is above `JOIN_THRESHOLD`. The assignment uses the group's title, so `planGrouping` matches it by name as today
5. **Cluster the rest.** Average-linkage agglomerative clustering with cosine-distance cutoff `CLUSTER_THRESHOLD`. Singleton clusters are classified by domain (a new group needs 2+ tabs anyway)
6. **Name each cluster.**
   - If most titles in the cluster are Latin script: call smart-tab-topic with `Topic from keywords: k1,k2,k3. titles: \n<up to 3 titles joined by \n>`, keywords being the top 3 c-TF-IDF terms in lower case. Reject `none`, `adult content` (case-insensitive) and empty output
   - Otherwise, or if rejected: join the top 1–2 c-TF-IDF keywords of the cluster
   - Otherwise: the domain display name of the cluster's most common domain (as `classifyByDomain`)
   - Names are trimmed and cut to 40 characters, like LLM names
7. Return `{ assignments, method: 'onDevice' }`. `method` is `'mixed'` when some tabs fell back to domain classification for any reason other than being singletons

### Keyword extraction

- Tokenize titles with `Intl.Segmenter(undefined, { granularity: 'word' })`, keep `isWordLike` segments, lower-case them
- Drop single-character tokens (in any script), pure numbers, and a small built-in English + Japanese stopword list
- c-TF-IDF: each cluster is one document; score = term frequency in the cluster × log(1 + average words per cluster / term frequency across all clusters)

### Thresholds

`JOIN_THRESHOLD` and `CLUSTER_THRESHOLD` are constants, not settings. They are chosen during implementation from a fixture of English and Japanese tab titles embedded once with the real model; the stored vectors are committed as test data so the thresholds are guarded by tests.

## 5. Model management

### Fetching and storage

- Transformers.js downloads the models from huggingface.co at pinned revisions and stores them with the Cache API in the extension's origin. They survive browser restarts and are removed on uninstall
- The download happens inside the Worker when its pipelines are first created. Progress callbacks update `storage.local` key `modelStatus`: `{ state: 'missing' | 'downloading' | 'ready' | 'error', progress?: number, error?: string, lastAttemptAt?: number }`
- A download starts when (a) an on-device run finds the models not ready, or (b) the user clicks "Download now" on the settings page. Only one download runs at a time
- During the download the event page is kept alive the same way as `whileKeepingAlive`
- On failure the state becomes `error`. Automatic retries happen on later runs, at most once per hour (`lastAttemptAt`). "Download now" ignores the back-off
- If loading cached models fails, delete the cache and set the state to `missing` when the cache is gone (evicted or cleared) or after 3 failed loads in a row (corrupt cache); a single failure (e.g. out of memory) keeps the models. Runs load cached models only and never download
- "Delete downloaded models" on the settings page deletes the cache and sets the state to `missing`

### Runtime

- `env.backends.onnx.wasm.wasmPaths` points to `browser.runtime.getURL('/ort/')`; nothing is loaded from a CDN
- `numThreads = 1`: extension pages are not cross-origin isolated, so SharedArrayBuffer is unavailable
- The Worker is created per run and always terminated in a `finally` block, so model memory is released after each run
- Inference for one run is limited to 60 seconds (well under the 5-minute run lock TTL); on timeout the Worker is terminated

### Privacy

- In on-device mode no tab data is sent anywhere. The only outgoing requests are GETs for model files on huggingface.co (and its CDN redirects)
- `data_collection_permissions` stays `none`
- The privacy section of the main design and the README are updated to mention the model download

## 6. UI

### Settings page

- The "LLM" fieldset becomes **"Classification method"** with three radio buttons:
  - **On-device AI (default)**: model status (missing / downloading xx% / ready, ~175 MB / error with reason), "Download now" and "Delete downloaded models" buttons, and a note: "Downloads about 175 MB from huggingface.co once. Tab data is never sent."
  - **Local LLM server**: the current fields (base URL, model, timeout, connection test), enabled only while this option is selected
  - **By domain**: no extra settings
- Saving with "Local LLM server" requests the host permission as today. Selecting on-device requests nothing
- The model status updates live via `storage.onChanged`
- Run history: add a label for `onDevice`; when a run fell back because the model was not ready, the notes column says so

### Popup

- The "LLM status" section becomes **"Classification status"**, showing the model status for on-device, the current LLM status for the LLM server, and "By domain" for domain
- No new buttons; download and delete live on the settings page

### Notifications

- Notify once when the on-device status changes to `error` (same mechanism as the LLM failure notification). Download start and completion are not notified

### Localization

- All new and changed strings are added to `public/_locales/en` and `public/_locales/ja`

## 7. Error handling

The rule stays the same as for the LLM: **any on-device failure falls back to domain classification for that run; tidying never stops.**

| Situation | Behaviour |
|---|---|
| Models missing or downloading | Domain classification for this run; start the download if missing. History notes "model not ready" (`modelNotReady`) |
| Download fails (offline, HTTP error, quota) | `modelStatus` → `error`; retry on a later run after at least 1 hour; notify once on the state change (`modelDownloadFailed`) |
| Worker fails to start or inference throws (WASM load failure, out of memory) | Domain classification for this run; keep the models; record the error (`inferenceFailed`) |
| Inference exceeds 60 seconds | Terminate the Worker; domain classification (`inferenceFailed`) |
| Topic model returns `None`, `Adult Content` or empty | Keyword name, then domain name |
| Cached models fail to load | If the cache is gone, or after 3 failures in a row: delete it, state → `missing`, download again next run. Otherwise keep the models |

## 8. Testing

### Unit tests (Vitest)

- `clusterTabs`: fixed vectors; threshold boundaries, joining existing groups, singleton handling, the 300-tab cap
- `nameCluster`: English and Japanese keyword extraction, stopwords, topic prompt format, rejected labels, Latin-script detection, 40-character cut
- `onDeviceClassifier` (Worker and browser APIs mocked): fallback and download start when models are not ready, fallback on inference error and timeout, `method` / `error` values, the Worker is always terminated
- `modelManager`: state transitions, 1-hour back-off, "Download now" bypassing the back-off, deletion, corrupt-cache recovery
- `settings`: migration from `llm.enabled` to `classifier`
- `orchestrator`: existing tests updated for the new `classify` argument and classifier selection
- Thresholds: tests over the committed fixture vectors (section 4)

### Manual tests (added to `docs/manual-test.md`)

The first three are verified as the first implementation task, before building the rest, because they decide whether this design holds:

1. Transformers.js runs in a Worker of the Firefox extension, and the Cache API persists the models
2. Models download from huggingface.co without adding host permissions
3. `Mozilla/smart-tab-topic` loads and generates with Transformers.js `text2text-generation`

Then:

- On a fresh profile, the first run starts the download, shows progress, and groups by domain
- After a restart, runs classify on-device without downloading again
- Offline: the error is shown and notified once; recovery after going back online
- Mixed English and Japanese tabs: clusters and names look reasonable
- "Delete downloaded models" returns the status to missing
- `web-ext lint` passes with the new CSP and bundled WASM

## 9. Out of scope

- Firefox `browser.trial.ml` (revisit if it becomes enabled by default in Release)
- Combining on-device and LLM-server classification (sending uncertain tabs to the LLM)
- Settings for the clustering thresholds
- Generating Japanese group names with a model
- Using page contents or descriptions as input
