# tab-tidy

A Firefox extension that tidies your open tabs on a schedule.

- **Merge duplicate tabs**: finds tabs showing the same page (by normalized URL) and closes all but the one you viewed most recently.
- **Sort tabs into tab groups**: puts ungrouped tabs into Firefox's native tab groups, grouped by content with an on-device AI by default. The models (about 175 MB) are downloaded once from huggingface.co; tab titles and URLs never leave your computer. A local LLM server (Ollama, LM Studio, or any OpenAI-compatible API) or plain domain grouping can be chosen instead.
- **Runs periodically**: at a fixed interval, and only while you are not using the browser.
- **Safety**: never closes pinned, active, or audio-playing tabs; re-checks every tab right before acting; the last run can be undone.

Requires Firefox 140 or later.

For the full design, see [`docs/superpowers/specs/2026-10-11-tab-organizer-design.md`](docs/superpowers/specs/2026-10-11-tab-organizer-design.md).

## Setup

```sh
npm install
```

## Trying it locally

### Option A: development mode (recommended)

```sh
npm run dev:firefox
```

This launches Firefox with the extension loaded and reloads it automatically when the code changes.

### Option B: load it into your regular Firefox temporarily

1. Run `npm run build:firefox`.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click "Load Temporary Add-on…" and select `.output/firefox-mv3/manifest.json`.

A temporary add-on is removed when Firefox restarts.

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

### Using a local LLM (Ollama)

Ollama rejects requests from extensions unless `OLLAMA_ORIGINS` allows them:

```sh
# bash / zsh
OLLAMA_ORIGINS='moz-extension://*' ollama serve

# fish
env OLLAMA_ORIGINS='moz-extension://*' ollama serve
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
npx web-ext lint -s .output/firefox-mv3   # lint before submitting to AMO
```

## Packaging for AMO

```sh
npm run zip:firefox
```

This writes the submission zips to `.output/`.

## Project layout

| Path | Contents |
|---|---|
| `core/` | Pure logic with no browser APIs: URL normalization, dedupe and grouping planners, domain classification |
| `services/` | Browser, LLM, and storage access: settings, LLM client, tab operations, undo, run orchestration, scheduling |
| `entrypoints/` | Background script, popup, settings page |
| `public/_locales/` | UI messages (`en`, `ja`) |
| `tests/` | Unit tests for `core/` and `services/` |
| `docs/` | Design spec, implementation plan, manual test checklist |
