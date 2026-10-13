# Chrome Support Design

- Date: 2026-10-12
- Status: awaiting review
- Builds on: [`2026-10-11-tab-organizer-design.md`](2026-10-11-tab-organizer-design.md), [`2026-10-11-on-device-classifier-design.md`](2026-10-11-on-device-classifier-design.md)

## 1. Purpose

Ship the extension for Google Chrome as well as Firefox, from the same codebase, and publish it on the Chrome Web Store. The Chrome build has the same features as the Firefox build, including the on-device classifier as the default.

### Success criteria

- `npm run build:chrome` produces an MV3 extension that loads in Chrome without errors, and `npm run zip:chrome` produces a zip fit for Chrome Web Store submission
- Every feature works in Chrome: duplicate merging, grouping with all three classifiers (on-device, LLM server, domain), scheduling, undo, settings, popup
- The Firefox build behaves exactly as before; its manifest gains no Chrome-only keys or permissions
- An incognito tab and a regular tab with the same URL are never treated as duplicates in Chrome
- No model inference keeps running, and no offscreen document stays open, after a run or download ends

### Assumptions

- Chrome is the target; other Chromium browsers (Edge etc.) may work but are not tested or supported
- Minimum Chrome version: 116 (`chrome.offscreen`, `runtime.getContexts`, `tabGroups` and the service worker keep-alive rules used below are all available)
- Submitting to the store (listing text, screenshots, publishing a privacy policy) is done by a person; this work only documents the steps

## 2. Summary of decisions

| Item | Decision |
|---|---|
| Codebase | One codebase; WXT builds per browser. Browser differences are selected with the build-time constants `import.meta.env.FIREFOX` / `import.meta.env.CHROME`, so each build contains only its own branch |
| On-device inference in Chrome | An offscreen document (reason `WORKERS`) starts the existing `services/ml/worker.ts` as a Worker and relays messages to the background service worker over a `runtime.Port`. Chrome service workers cannot start dedicated Workers |
| Rejected: inference directly in the offscreen document | Would split `worker.ts` into a Worker version and a page version |
| Rejected: separate Chrome branch or directory | Doubles maintenance |
| ML client interface | `MlClient` is unchanged. Only the transport under `createMlClient` differs per browser |
| Duplicate key in Chrome | Chrome tabs have no `cookieStoreId`; the key comes from `tab.incognito` (`'incognito'` / `'default'`) |
| Icons | PNG icons (16, 32, 48, 128) for Chrome manifests and for notifications in both browsers; Chrome does not accept SVG there |
| Ollama setup text | The extension origin in messages is a placeholder filled per browser (`moz-extension://*` / `chrome-extension://*`) |

## 3. Architecture

### New files

```
entrypoints/offscreen/
  index.html            Chrome-only unlisted page; loads main.ts
  main.ts               Calls startRelay() from services/ml/offscreenRelay.ts
services/ml/
  offscreenTransport.ts Background side (Chrome): creates/reuses/closes the offscreen document,
                        opens one Port per client, exposes a Worker-like object
  offscreenRelay.ts     Offscreen side: one Worker per Port, relays messages both ways
public/
  icon-16.png, icon-32.png, icon-48.png, icon-128.png   Rendered from icon.svg and committed
```

WXT must not include `entrypoints/offscreen/` in the Firefox build. It is limited to Chrome with the entrypoint's `include: ['chrome']` option (set in `index.html` meta tags).

### Changes to existing code

- `services/ml/client.ts`: `createMlClient(spawn)` takes `() => WorkerLike`, where `WorkerLike` is the subset the client uses: `postMessage`, `onmessage`, `onerror`, `terminate`. The default `spawn` is `new Worker(...)` in Firefox and `createOffscreenWorker()` from `offscreenTransport.ts` in Chrome. Request ids, progress and `failAll` stay as they are.
- `services/tabsAdapter.ts`: when `cookieStoreId` is missing, the key is `'incognito'` if `tab.incognito` is true, else `'default'`. `'firefox-default'` stays the Firefox default.
- `wxt.config.ts`: `manifest` becomes a function of the target browser.
  - Firefox: unchanged (`browser_specific_settings.gecko`, SVG icons kept).
  - Chrome: adds the `offscreen` permission and `minimum_chrome_version: '116'`; uses the PNG icons; no `browser_specific_settings`.
- `entrypoints/background.ts`: on Chrome, at every service worker start, calls `closeIdleOffscreen()` (see §4) next to `resetInterruptedDownload()`.
- `services/modelManager.ts`, `services/orchestrator.ts`: notification `iconUrl` uses `/icon-128.png`.
- `public/_locales/{en,ja}/messages.json`: the two messages that contain `moz-extension://*` (`ollamaGuide` and `notifyForbidden`) take an `$ORIGIN$` placeholder. Callers pass the origin pattern for the running browser from one helper, `extensionOriginPattern()` in `services/i18n.ts`, derived at run time from `browser.runtime.getURL('/')` (`moz-extension://*` / `chrome-extension://*`).
- `services/undoLog.ts`: when recreating a closed tab, `cookieStoreId` is passed to `tabs.create` only in Firefox. Chrome rejects the unknown property, which would make undo fail for every tab whose session entry expired; `windowId` already places the tab in the right (regular or incognito) window.
- `package.json`: adds `dev:chrome`, `build:chrome`, `zip:chrome`.
- `README.md`: describes both browsers (setup, loading unpacked in Chrome, `OLLAMA_ORIGINS=chrome-extension://*`) and adds a "Submitting to the Chrome Web Store" section (§6).

### Unchanged

`core/`, `services/ml/worker.ts`, `services/ml/protocol.ts`, the `MlClient` interface, `services/onDeviceClassifier.ts`, and the logic in `services/modelManager.ts`. The model cache (`caches`) belongs to the extension origin, so the Worker inside the offscreen document and the background service worker see the same cache; deleting and counting model files works as it does now.

## 4. Offscreen document lifecycle (Chrome)

### Creation

On the first message a client sends (lazily, like the Worker today):

1. `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })` checks for an existing document.
2. If there is none, `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Runs the on-device tab classifier in a Web Worker' })`.
3. Only one offscreen document may exist per extension. A module-level promise for the creation in progress is shared by concurrent callers, so `createDocument` runs at most once at a time.

Messages posted before the document and Port are ready are queued in the transport and sent in order once connected.

The offscreen page may not have registered its `onConnect` listener yet when `createDocument` resolves. The relay therefore answers every new Port with `{ type: 'relayReady' }`, and the transport sends queued messages only after that. A Port that disconnects before `relayReady` is retried, up to 5 connects 200 ms apart; after that the transport raises `onerror`.

### Clients, Ports and Workers

Each `createMlClient()` opens one Port (name `ml`). The relay starts one Worker per Port. A model download running alongside a classification run therefore uses two Workers, as in Firefox.

### Teardown

- `terminate()` disconnects the Port; the relay terminates that Port's Worker on `onDisconnect`.
- An offscreen document cannot use `chrome.offscreen`, so the background counts open Ports. When the count reaches 0, it calls `chrome.offscreen.closeDocument()`. A close that races with a new client is handled by awaiting the close before the next creation.

### Service worker restart

- When the service worker stops, its Ports disconnect and the relay terminates every Worker.
- The offscreen document itself survives. `closeIdleOffscreen()` runs at every service worker start and closes any offscreen document found while this service worker has no open Ports. An interrupted download is then reset by the existing `resetInterruptedDownload()`.

### Keeping long work alive

`whileKeepingAlive` (an extension API call every 20 s) also resets the Chrome service worker idle timer, so it is used unchanged.

## 5. Error handling

Every Chrome-specific failure becomes an ordinary `MlClient` failure (a rejected promise). The existing behaviour then applies: domain fallback, the 60 s classifier timeout, and `noteLoadFailure` deleting models after 3 load failures in a row.

| Event | Transport behaviour | Result |
|---|---|---|
| `createDocument` fails (e.g. blocked by policy) | `onerror` fires; all pending requests reject | The load fails; that run uses domain classification |
| The Worker fails to start or throws in the offscreen document | The relay sends `{ type: 'workerError', message }` over the Port; the transport raises `onerror` | Same as a Worker error in Firefox today |
| The Port disconnects without `terminate()` (offscreen crash, closed from outside) | `onerror` with `ML offscreen document closed` | Same as above |
| Inference never finishes | No change | The 60 s timeout falls back to domain classification |

A failure to create the offscreen document counts as one model load failure, so three in a row delete and re-download the models although the files may be fine. This matches the current rule for a Worker that will not start; telling the cases apart would need a failure kind in `MlClient`, which is not worth it now.

`relayReady` and `workerError` are relay-only message types defined in `offscreenTransport.ts` / `offscreenRelay.ts`; `MlResponse` in `protocol.ts` is unchanged.

## 6. Chrome Web Store submission (documented, not automated)

The README section covers:

- `npm run zip:chrome` and which file in `.output/` to upload
- A purpose statement for each permission: `tabs`, `tabGroups`, `alarms`, `idle`, `storage`, `notifications`, `sessions`, `offscreen` (runs the WASM classifier in a Web Worker), optional host permissions (only the LLM server the user configures)
- Single purpose statement and the data disclosure: no user data is collected; tab titles and URLs go only to the LLM server the user configures, or nowhere in on-device mode
- Remote code: none. ONNX Runtime WASM is bundled; only model weight files are downloaded from huggingface.co, and they are data, not code

## 7. Testing

### Unit tests (Vitest)

- `tests/services/ml/client.test.ts`: existing tests keep passing unchanged (`FakeWorker` already satisfies `WorkerLike`).
- `tests/services/ml/offscreenTransport.test.ts` (new): `chrome.offscreen` and `runtime.getContexts` / `connect` are injected fakes (WXT's `fakeBrowser` has no offscreen support). Cases:
  - an existing document is reused, not created again
  - concurrent first messages call `createDocument` once
  - messages posted before connection are delivered in order, and only after `relayReady`
  - a Port that disconnects before `relayReady` is retried; after 5 failed connects `onerror` fires
  - closing the last Port calls `closeDocument`; closing one of two does not
  - an unexpected disconnect raises `onerror`
  - `workerError` is turned into `onerror`
  - `closeIdleOffscreen()` closes an existing document when no Port is open
- `tests/services/ml/offscreenRelay.test.ts` (new), with an injected Worker factory:
  - every new Port gets `relayReady`; one Worker per Port
  - messages relayed both ways unchanged
  - disconnect terminates the Worker
  - a Worker error is sent back as `workerError`
- `tests/services/tabsAdapter.test.ts`: without `cookieStoreId`, `incognito: true` and `false` give different keys.
- `tests/services/undoLog.test.ts`: the Chrome create properties carry no `cookieStoreId`; the Firefox ones keep it.
- `tests/services/i18n.test.ts`: messages with `$ORIGIN$` include the origin pattern for the browser.

### Build checks

- `npm run compile`, `npm test`, `npm run build:firefox`, `npm run build:chrome` all pass
- `npx web-ext lint -s .output/firefox-mv3` passes
- The Firefox manifest has no `offscreen` permission and no `minimum_chrome_version`; the Chrome manifest has no `browser_specific_settings`; the Firefox output has no `offscreen.html`

### Manual tests (added to `docs/manual-test.md`)

The existing checklist applies to both browsers; setup gains the Chrome steps (`npm run build:chrome`, loading `.output/chrome-mv3` unpacked from `chrome://extensions`; `npm run dev:chrome` serves the offscreen scripts from the dev server, so it only exercises the LLM server and domain modes, not on-device AI). A new Chrome section:

- Load unpacked: no errors on `chrome://extensions`; PNG icon in the toolbar and in notifications
- On-device: first run downloads the models, later runs group by content; after the run, no offscreen document is listed under "Inspect views"
- Stop the service worker during a download (`chrome://serviceworker-internals`): at the next start the leftover offscreen document is closed and the model status returns to "missing"
- Incognito: allow the extension in incognito, open the same URL in a regular and an incognito window, run; neither tab is closed
- Ollama: with `OLLAMA_ORIGINS=chrome-extension://*`, the connection test succeeds; without it, the 403 guide shows `chrome-extension://*`

## 8. Out of scope

- Edge and other Chromium browsers
- Publishing the store listing, screenshots and a hosted privacy policy
- CI for building or testing both browsers
- Distinguishing offscreen creation failures from model load failures
