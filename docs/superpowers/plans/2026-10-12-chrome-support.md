# Chrome Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and ship the extension for Chrome (Chrome Web Store) from the same codebase, with every Firefox feature including the on-device classifier.

**Architecture:** WXT builds per browser; differences use `import.meta.env.FIREFOX` / `CHROME` or run-time data. In Chrome the background service worker cannot start Workers, so an offscreen document runs the unchanged `services/ml/worker.ts` and relays messages over a `runtime.Port`; `createMlClient` sees a Worker-like object either way. Smaller fixes: incognito-aware duplicate key, undo without `cookieStoreId`, PNG icons, per-browser Ollama origin text.

**Tech Stack:** TypeScript, WXT 0.21 (MV3; Firefox event page, Chrome service worker), Vitest with `wxt/testing/fake-browser`, `@huggingface/transformers` 4.3.1, `chrome.offscreen`.

**Spec:** `docs/superpowers/specs/2026-10-12-chrome-support-design.md`

## Global Constraints

- Firefox build unchanged in behaviour: keeps `browser_specific_settings.gecko` (`strict_min_version: '140.0'`, `data_collection_permissions: { required: ['none'] }`), gains no `offscreen` permission, no `minimum_chrome_version`, no `offscreen.html`
- Chrome build: `minimum_chrome_version: '116'`, permissions = Firefox's list plus `offscreen`, no `browser_specific_settings`
- `MlClient` interface, `services/ml/worker.ts` and `services/ml/protocol.ts` are not changed
- Offscreen document: `url: 'offscreen.html'`, `reasons: ['WORKERS']`, `justification: 'Runs the on-device tab classifier in a Web Worker'`; Port name `ml`
- Relay-only messages (offscreen → background): `{ type: 'relayReady' }`, `{ type: 'workerError'; message: string }`
- Connect retry: up to 5 connects, 200 ms apart; unexpected disconnect error text: `ML offscreen document closed`
- Duplicate key without `cookieStoreId`: `'incognito'` when `tab.incognito`, else `'default'`
- Icons: `public/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`, rendered from `public/icon.svg`; notifications use `/icon-128.png` in both browsers
- Every new or changed UI string goes into both `public/_locales/en/messages.json` and `ja/messages.json` (enforced by `tests/services/i18n.test.ts`)
- Vitest runs with WXT's default browser (chrome): `import.meta.env.CHROME` is true in tests
- Commit style: `feat:`, `fix:`, `docs:`, `test:`, `chore:`; every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Work on branch `feat/chrome-support`

## Review Focus

1. **Offscreen page not listening yet** when `createDocument` resolves: the first connect is dropped and the first run would fall back to domain classification. The `relayReady` handshake with retry covers it (Task 5 test `retries a Port that closes before relayReady`).
2. **Undo after the session entry expired in Chrome**: `tabs.create` with `cookieStoreId` throws, so the tab is never restored (Task 2 test `chrome create properties have no cookieStoreId`).
3. **A run while the previous offscreen document is still closing**: creating while closing fails with "Only a single offscreen document may be created" (Task 5 test `waits for a pending close before creating`).
4. **Download and run in parallel** (two clients): terminating one must not close the document the other is using (Task 5 test `closing one of two Ports keeps the document`).
5. **Incognito tab with the same URL as a regular tab** must not be closed as a duplicate (Task 2 test `incognito and regular tabs get different keys`).

---

### Task 1: Per-browser manifest, PNG icons and scripts

**Files:**
- Create: `public/icon-16.png`, `public/icon-32.png`, `public/icon-48.png`, `public/icon-128.png`, `scripts/check-manifests.mjs`
- Modify: `wxt.config.ts`, `package.json`, `services/modelManager.ts:32`, `services/orchestrator.ts:60`

**Interfaces:**
- Produces: `npm run dev:chrome` / `build:chrome` / `zip:chrome`; `npm run check:manifests` (builds nothing, reads `.output/*/manifest.json`)

- [ ] **Step 1: Write `scripts/check-manifests.mjs`** — reads `.output/firefox-mv3/manifest.json` and `.output/chrome-mv3/manifest.json`, exits 1 with a message on the first failed assertion:
  - firefox: `browser_specific_settings.gecko.strict_min_version === '140.0'`; `permissions` excludes `offscreen`; no `minimum_chrome_version`; file `.output/firefox-mv3/offscreen.html` does not exist
  - chrome: no `browser_specific_settings`; `minimum_chrome_version === '116'`; `permissions` includes `offscreen`; every icon path in `icons` and `action.default_icon` ends in `.png` and exists in `.output/chrome-mv3/`
  
  Add `"check:manifests": "node scripts/check-manifests.mjs"` to `package.json` scripts, along with `"dev:chrome": "wxt -b chrome"`, `"build:chrome": "wxt build -b chrome"`, `"zip:chrome": "wxt zip -b chrome"`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build:firefox && npm run build:chrome && npm run check:manifests`
Expected: FAIL on the chrome `minimum_chrome_version` (or `browser_specific_settings`) assertion. (The `offscreen.html` checks only become meaningful after Task 5.)

- [ ] **Step 3: Render icons**

Run: `for s in 16 32 48 128; do rsvg-convert -w $s -h $s public/icon.svg -o public/icon-$s.png; done`

- [ ] **Step 4: Make `manifest` in `wxt.config.ts` a function `({ browser }) => UserManifest`**

Shared keys stay as they are. Firefox: current `icons`/`action` (SVG) and `browser_specific_settings`. Chrome: `icons` / `action.default_icon` = `{ 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' }`, `minimum_chrome_version: '116'`, permissions plus `'offscreen'`. Change both notification `iconUrl`s to `browser.runtime.getURL('/icon-128.png')`.

- [ ] **Step 5: Verify**

Run: `npm run build:firefox && npm run build:chrome && npm run check:manifests && npm run compile && npm test && npx web-ext lint -s .output/firefox-mv3`
Expected: all pass (web-ext lint: 0 errors)

- [ ] **Step 6: Commit** — `feat: build a Chrome MV3 manifest with PNG icons`

---

### Task 2: Incognito duplicate key and Chrome-safe undo

**Files:**
- Modify: `services/tabsAdapter.ts:15-39`, `services/undoLog.ts:50-53`, `core/types.ts:7` (comment only)
- Test: `tests/services/tabsAdapter.test.ts`, `tests/services/undoLog.test.ts`

**Interfaces:**
- Produces: `export function cookieStoreKey(t: { cookieStoreId?: string; incognito?: boolean }): string` in `services/tabsAdapter.ts`; `export function recreateProperties(url: string, windowId: number, cookieStoreId: string | undefined, firefox: boolean): Browser.tabs.CreateProperties` in `services/undoLog.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tabsAdapter.test.ts
it('incognito and regular tabs get different keys', () => {
  expect(cookieStoreKey({ incognito: true })).toBe('incognito');
  expect(cookieStoreKey({ incognito: false })).toBe('default');
  expect(cookieStoreKey({})).toBe('default');
});
it('keeps the Firefox cookieStoreId when present', () => {
  expect(cookieStoreKey({ cookieStoreId: 'firefox-container-1', incognito: false })).toBe('firefox-container-1');
});
it('snapshot keys tabs without cookieStoreId by incognito', async () => {
  vi.spyOn(browser.tabs, 'query').mockResolvedValue([
    { id: 1, windowId: 1, url: U, incognito: false }, { id: 2, windowId: 2, url: U, incognito: true },
  ] as never);
  const s = await snapshot();
  expect(s.tabs.map((t) => t.cookieStoreId)).toEqual(['default', 'incognito']);
});

// undoLog.test.ts
it('chrome create properties have no cookieStoreId', () => {
  expect(recreateProperties(U, 3, 'default', false)).toEqual({ url: U, windowId: 3 });
});
it('firefox create properties keep cookieStoreId', () => {
  expect(recreateProperties(U, 3, 'firefox-container-1', true)).toEqual({ url: U, windowId: 3, cookieStoreId: 'firefox-container-1' });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/services/tabsAdapter.test.ts tests/services/undoLog.test.ts`
Expected: FAIL — `cookieStoreKey` / `recreateProperties` not exported

- [ ] **Step 3: Implement** `cookieStoreKey` (used by `toTabInfo` in place of the `DEFAULT_COOKIE_STORE` fallback; remove that constant) and `recreateProperties` (used by `defaultPorts().create` with `firefox = import.meta.env.FIREFOX`). Update the `core/types.ts` comment to `container / private window; 'incognito' | 'default' in Chrome`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test && npm run compile`
Expected: PASS

- [ ] **Step 5: Commit** — `fix: key duplicates by incognito and drop cookieStoreId on undo in Chrome`

---

### Task 3: Per-browser Ollama origin in messages

**Files:**
- Modify: `public/_locales/en/messages.json` (`ollamaGuide`, `notifyForbidden`), `public/_locales/ja/messages.json` (same keys), `services/i18n.ts`, `entrypoints/options/main.ts:20`, `services/orchestrator.ts:80`
- Test: `tests/services/i18n.test.ts`

**Interfaces:**
- Produces: `export function extensionOriginPattern(): string` in `services/i18n.ts` — `'<protocol>//*'` from `browser.runtime.getURL('/')`, e.g. `chrome-extension://*`

- [ ] **Step 1: Write the failing tests**

```ts
it('extensionOriginPattern follows the running browser', () => {
  expect(extensionOriginPattern()).toBe('chrome-extension://*'); // fakeBrowser serves chrome-extension:// URLs
});
it.each(['ollamaGuide', 'notifyForbidden'])('%s includes the origin', (key) => {
  expect(t(key, 'chrome-extension://*')).toContain('OLLAMA_ORIGINS=chrome-extension://*');
  expect(en[key]!.message).not.toContain('moz-extension');
  expect(ja[key]!.message).not.toContain('moz-extension');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/services/i18n.test.ts`
Expected: FAIL — `extensionOriginPattern` not exported

- [ ] **Step 3: Implement** — in both locales replace `moz-extension://*` with `$ORIGIN$` and add `"placeholders": { "origin": { "content": "$1" } }`; add `extensionOriginPattern`; call sites become `t('ollamaGuide', extensionOriginPattern())` and `t('notifyForbidden', extensionOriginPattern())`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test && npm run compile`
Expected: PASS

- [ ] **Step 5: Commit** — `feat: show the Ollama origin for the running browser`

---

### Task 4: Worker-like client seam and offscreen relay

**Files:**
- Create: `services/ml/offscreenRelay.ts`, `entrypoints/offscreen/index.html`, `entrypoints/offscreen/main.ts`
- Modify: `services/ml/client.ts`
- Test: `tests/services/ml/offscreenRelay.test.ts`, `tests/services/ml/client.test.ts` (unchanged, must stay green)

**Interfaces:**
- Produces in `services/ml/client.ts`:
  ```ts
  export interface WorkerLike {
    postMessage(msg: MlRequest): void;
    onmessage: ((ev: { data: MlResponse }) => void) | null;
    onerror: ((ev: { message: string }) => void) | null;
    terminate(): void;
  }
  export function createMlClient(spawn?: () => WorkerLike): MlClient;
  ```
- Produces in `services/ml/offscreenRelay.ts`:
  ```ts
  export const ML_PORT = 'ml';
  export type RelayMessage = MlResponse | { type: 'relayReady' } | { type: 'workerError'; message: string };
  export interface PortLike {
    name: string;
    postMessage(msg: unknown): void;
    onMessage: { addListener(fn: (msg: unknown) => void): void };
    onDisconnect: { addListener(fn: () => void): void };
    disconnect(): void;
  }
  export function startRelay(
    onConnect: (fn: (port: PortLike) => void) => void,
    spawn?: () => Worker, // default: new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  ): void;
  ```

- [ ] **Step 1: Write the failing tests** (`offscreenRelay.test.ts`, with a `FakePort` recording `sent` and exposing `emit(msg)` / `disconnectFromOtherSide()`, and the `FakeWorker` pattern from `client.test.ts`)

  - `every new Port gets relayReady and its own Worker` — two ports connect → each `sent[0]` is `{ type: 'relayReady' }`; spawn called twice
  - `ignores Ports with another name` — port named `other` → no spawn, nothing sent
  - `relays requests to the Worker and responses to the Port` — `port.emit({ id: 1, type: 'embed', texts: ['a'] })` → `worker.sent` has it; `worker.reply({ id: 1, ok: true, result: [[1]] })` → port `sent` includes it unchanged
  - `disconnect terminates the Worker` — `disconnectFromOtherSide()` → `worker.terminate` called
  - `Worker errors are sent back as workerError` — `worker.onerror({ message: 'boom' })` → port `sent` includes `{ type: 'workerError', message: 'boom' }`; empty message becomes `'ML worker error'`
  - `spawn failure is sent back as workerError` — spawn throws `Error('no')` → `{ type: 'workerError', message: 'no' }`

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/services/ml/offscreenRelay.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**
  - `client.ts`: replace `Worker` types with `WorkerLike`; `onerror` reads `ev.message`. No behaviour change.
  - `offscreenRelay.ts`: `startRelay` as specified.
  - `entrypoints/offscreen/index.html`: minimal page with `<meta name="manifest.include" content="['chrome']" />` and `<script type="module" src="./main.ts"></script>`.
  - `entrypoints/offscreen/main.ts`: `startRelay((fn) => browser.runtime.onConnect.addListener(fn as never));`

- [ ] **Step 4: Verify**

Run: `npm test && npm run compile && npm run build:firefox && npm run build:chrome && ls .output/chrome-mv3/offscreen.html && npm run check:manifests`
Expected: PASS; `offscreen.html` exists in the Chrome output only

- [ ] **Step 5: Commit** — `feat: add the offscreen relay for the ML worker`

---

### Task 5: Offscreen transport and Chrome wiring

**Files:**
- Create: `services/ml/offscreenTransport.ts`
- Modify: `services/ml/client.ts` (default `spawn`), `entrypoints/background.ts`
- Test: `tests/services/ml/offscreenTransport.test.ts`

**Interfaces:**
- Consumes: `WorkerLike` (Task 4), `ML_PORT`, `RelayMessage`, `PortLike` (Task 4)
- Produces:
  ```ts
  export interface OffscreenDeps {
    hasDocument(): Promise<boolean>;   // runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).length > 0
    createDocument(): Promise<void>;   // offscreen.createDocument with the constraint values
    closeDocument(): Promise<void>;
    connect(): PortLike;               // runtime.connect({ name: ML_PORT })
    delay(ms: number): Promise<void>;
  }
  export interface OffscreenHost {
    spawn(): WorkerLike;
    closeIdle(): Promise<void>;        // closes an existing document when this host has no open Port
  }
  export function createOffscreenHost(deps?: OffscreenDeps): OffscreenHost;
  export const offscreenHost: OffscreenHost; // module singleton with browser-backed deps, created lazily
  ```

- [ ] **Step 1: Write the failing tests** (fake deps with call counters; `FakePort` whose `connect()` result is scripted to send `relayReady`, or to disconnect immediately; `delay` resolves at once)

  - `reuses an existing document` — `hasDocument → true` → `createDocument` not called
  - `concurrent first messages create the document once` — two `spawn()`s, each `postMessage` in the same tick → `createDocument` called once
  - `queues messages until relayReady` — post two requests before ready → nothing on the port; after `relayReady` both sent in order
  - `retries a Port that closes before relayReady` — first 2 connects disconnect immediately, 3rd sends ready → requests delivered, no `onerror`
  - `gives up after 5 failed connects` — all disconnect → `onerror` called once with message `ML offscreen document closed`; `connect` called 5 times
  - `forwards responses to onmessage` — port emits `{ id: 1, ok: true, result: 1 }` → `onmessage({ data: ... })`
  - `workerError becomes onerror` — port emits `{ type: 'workerError', message: 'boom' }` → `onerror({ message: 'boom' })`
  - `unexpected disconnect after ready raises onerror` — `ML offscreen document closed`
  - `terminate disconnects without onerror and closes the last document` — `terminate()` → `port.disconnect` called, `onerror` not called, `closeDocument` called once
  - `closing one of two Ports keeps the document` — two workers ready, terminate one → `closeDocument` not called; terminate the other → called
  - `waits for a pending close before creating` — `closeDocument` returns an unresolved promise; spawn + post → `createDocument` not called until it resolves
  - `closeIdle closes a leftover document` — `hasDocument → true`, no ports → `closeDocument` called; `hasDocument → false` → not called
  - `createDocument failure raises onerror` — rejects `Error('blocked')` → `onerror({ message: 'blocked' })`

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/services/ml/offscreenTransport.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**
  - `offscreenTransport.ts` as specified. Host state: `openPorts: number`, `creating: Promise<void> | null`, `closing: Promise<void> | null`. `ensureDocument()` awaits `closing`, then shares `creating`. A Worker-like's `terminate()` before connection still counts down and never connects afterwards. `closeDocument` errors are swallowed (document may already be gone).
  - `client.ts` default spawn: `import.meta.env.CHROME ? offscreenHost.spawn() : new Worker(...)`. Import `offscreenHost` so the Firefox build tree-shakes it (the branch is a build-time constant).
  - `background.ts`: inside `defineBackground`, next to `resetInterruptedDownload()`: `if (import.meta.env.CHROME) offscreenHost.closeIdle().catch(console.error);`

- [ ] **Step 4: Verify**

Run: `npm test && npm run compile && npm run build:firefox && npm run build:chrome && npm run check:manifests && ! grep -rl "createDocument" .output/firefox-mv3`
Expected: all pass; the Firefox output contains no offscreen code

- [ ] **Step 5: Commit** — `feat: run the on-device classifier through an offscreen document in Chrome`

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`, `docs/manual-test.md`

- [ ] **Step 1: README** — intro says "A Firefox and Chrome extension"; requirements: Firefox 140+ or Chrome 116+; "Trying it locally" gains `npm run dev:chrome` and "load `.output/chrome-mv3` unpacked from `chrome://extensions` (Developer mode)"; Ollama section shows `OLLAMA_ORIGINS='chrome-extension://*'` for Chrome (both origins may be combined: `'moz-extension://*,chrome-extension://*'`); "Tests and checks" adds `build:chrome` and `check:manifests`; new section "Submitting to the Chrome Web Store" with the content of spec §6 (zip command and upload file, per-permission purposes, single purpose, no data collected, no remote code).

- [ ] **Step 2: manual-test.md** — header says checks run in Firefox and Chrome; setup lists the Chrome steps; new section "G. Chrome" with the five checks from spec §7 (each with Steps / Expected / `Result: Not run`, same format as existing items).

- [ ] **Step 3: Verify** — `npm test` (i18n tests scan entrypoints only; docs do not affect them) and read both files rendered once.

- [ ] **Step 4: Commit** — `docs: describe Chrome setup, checks and store submission`

---

### Final check

- [ ] Run: `npm run compile && npm test && npm run build:firefox && npm run build:chrome && npm run check:manifests && npx web-ext lint -s .output/firefox-mv3 && npm run zip:chrome`
- Expected: all pass; `.output/` contains the Chrome zip
