# Local LLM Tab Organizer

A Firefox and Chrome extension that tidies your open tabs on a schedule.

- **Merge duplicate tabs**: finds tabs showing the same page (by normalized URL) and closes all but the one you viewed most recently.
- **Sort tabs into tab groups**: puts ungrouped tabs into the browser's native tab groups, grouped by content with an on-device AI by default. The models (about 175 MB) are downloaded once from huggingface.co; tab titles and URLs never leave your computer. A local LLM server (Ollama, LM Studio, or any OpenAI-compatible API) or plain domain grouping can be chosen instead.
- **Runs periodically**: at a fixed interval, and only while you are not using the browser.
- **Safety**: never closes pinned, active, or audio-playing tabs; re-checks every tab right before acting; the last run can be undone.

Requires Firefox 140 or later, or Chrome 116 or later.

For the full design, see [`docs/superpowers/specs/2026-10-11-tab-organizer-design.md`](docs/superpowers/specs/2026-10-11-tab-organizer-design.md).

## Setup

```sh
npm install
```

## Trying it locally

### Option A: development mode (recommended)

```sh
npm run dev:firefox   # Firefox
npm run dev:chrome    # Chrome
```

This launches the browser with the extension loaded and reloads it automatically when the code changes.

Note for Chrome: in dev mode the offscreen page's scripts are served from the dev server, so the on-device ML worker cannot start there. `npm run dev:chrome` only exercises the LLM server and domain modes. To test on-device AI in Chrome, run `npm run build:chrome` and load `.output/chrome-mv3` unpacked from `chrome://extensions`.

### Option B: load it into your regular Firefox temporarily

1. Run `npm run build:firefox`.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click "Load Temporary Add-on…" and select `.output/firefox-mv3/manifest.json`.

A temporary add-on is removed when Firefox restarts.

### Option C: load it into Chrome

1. Run `npm run build:chrome`.
2. Open `chrome://extensions` and turn on "Developer mode".
3. Click "Load unpacked" and select `.output/chrome-mv3`.

To see incognito tabs, allow the extension in incognito from its details page. In Chrome, duplicate detection treats incognito tabs separately from regular tabs, so the two are never merged with each other.

### What to check

- By default, duplicate merging is **automatic** and grouping is **suggest-only**. Review grouping suggestions in the popup (toolbar button) and choose Apply or Discard.
- To see scheduled runs quickly, set the run interval to `1` minute and the idle threshold to `15` seconds on the settings page.
- "Run now" in the popup runs immediately, without waiting for idle.
- Results of each run are listed in the run history on the settings page.
- Step-by-step checks with expected results are in [`docs/manual-test.md`](docs/manual-test.md).

The UI follows the browser language: English and Japanese are supported (`public/_locales/`), with English as the default.

### On-device AI (default)

Nothing to set up. On the first run the extension downloads two models from huggingface.co (about 175 MB) and groups by domain until the download finishes; later runs group by content. The settings page shows the download status and can download the models right away or delete them.

- Tabs are embedded with `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (English and Japanese work) and clustered; similar tabs also join existing groups.
- Groups of mostly English titles are named by `Mozilla/smart-tab-topic` (the model Firefox's own tab grouping uses); others are named by their most distinctive words, or by domain.
- Inference runs in a Worker with ONNX Runtime WASM bundled in the extension, so the extension is about 27 MB.
- In Chrome, the service worker cannot start Workers, so the Worker runs inside an offscreen document. The document is closed after each run or download.

### Using a local LLM (Ollama)

Ollama rejects requests from extensions unless `OLLAMA_ORIGINS` allows them:

```sh
# bash / zsh
OLLAMA_ORIGINS='moz-extension://*' ollama serve

# fish
env OLLAMA_ORIGINS='moz-extension://*' ollama serve
```

For Chrome, use `chrome-extension://*` instead. To allow both browsers, combine the origins:

```sh
# Chrome only
OLLAMA_ORIGINS='chrome-extension://*' ollama serve

# Firefox and Chrome
OLLAMA_ORIGINS='moz-extension://*,chrome-extension://*' ollama serve
```

In another terminal, pull a model, for example:

```sh
ollama pull qwen3:4b
```

Then, on the extension's settings page:

1. Keep the base URL at `http://localhost:11434/v1` (the default).
2. Click "Test connection" and allow the permission prompt.
3. Pick a model from the suggestions, select "Local LLM server" as the classification method, and save.

If `OLLAMA_ORIGINS` is missing, the connection test shows a 403 error with setup instructions. Whenever the LLM cannot be reached, the extension falls back to grouping by domain.

## Tests and checks

```sh
npm test                                  # unit tests (Vitest)
npm run compile                           # type check
npm run build:firefox                     # build for Firefox (.output/firefox-mv3)
npm run build:chrome                      # build for Chrome (.output/chrome-mv3)
npm run check:manifests                   # check both built manifests (run after building both)
npx web-ext lint -s .output/firefox-mv3   # lint before submitting to AMO
```

## Packaging for AMO

```sh
npm run zip:firefox
```

This writes the submission zips to `.output/`.

## Submitting to the Chrome Web Store

```sh
npm run zip:chrome
```

Upload `.output/local-llm-tab-organizer-<version>-chrome.zip` (the only file `zip:chrome` writes). Text for the store listing's privacy tab:

**Permission purposes**

| Permission | Purpose |
|---|---|
| `tabs` | Read tab titles and URLs to find duplicates and classify tabs; close duplicates |
| `tabGroups` | Create, name, and colour tab groups |
| `alarms` | Run the organizer at the configured interval |
| `idle` | Run only while the user is not using the browser |
| `storage` | Save settings, run history, and undo data |
| `notifications` | Report the result of a run |
| `sessions` | Restore closed tabs when the user undoes a run |
| `offscreen` | Run the on-device classifier (a WASM model in a Web Worker) in an offscreen document, because the service worker cannot start Workers |
| Optional host permissions (`http://*/*`, `https://*/*`) | Requested at runtime only for the LLM server URL the user configures |

**Single purpose**: Tidy open tabs by merging duplicates and sorting tabs into tab groups.

**Data disclosure**: No user data is collected. Tab titles and URLs are sent only to the LLM server the user configures, or nowhere in on-device mode.

**Remote code**: None. ONNX Runtime WASM is bundled in the extension. Only model weight files are downloaded from huggingface.co, and they are data, not code.

## Project layout

| Path | Contents |
|---|---|
| `core/` | Pure logic with no browser APIs: URL normalization, dedupe and grouping planners, domain classification |
| `services/` | Browser, LLM, and storage access: settings, LLM client, tab operations, undo, run orchestration, scheduling |
| `entrypoints/` | Background script, popup, settings page |
| `public/_locales/` | UI messages (`en`, `ja`) |
| `tests/` | Unit tests for `core/` and `services/` |
| `docs/` | Design spec, implementation plan, manual test checklist |
