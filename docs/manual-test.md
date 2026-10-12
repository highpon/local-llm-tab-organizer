# Manual Integration Test Checklist

Checks to run in a real Firefox. A person fills in every "Result" (all items are currently "Not run").

The extension's UI follows the browser language (English or Japanese). UI labels are quoted in English, with the Japanese label in parentheses.

## Setup

1. Install dependencies: `npm install`
2. Start Firefox in development mode: `npx wxt -b firefox` (the extension is loaded as a temporary add-on)
3. Open the settings page from the "Settings" ("設定") button in the popup. To shorten waits for the schedule checks, set the run interval (minutes) to 1 and the idle threshold (seconds) to 15, then save.
4. Extra setup for the LLM items (section E):
   - Install Ollama.
   - Start it with extension access allowed: `OLLAMA_ORIGINS=moz-extension://* ollama serve`
   - Pull a small model (e.g. `ollama pull qwen2.5:1.5b`).
   - On the settings page, select "Local LLM server" ("ローカル LLM サーバー") as the classification method, set the base URL to `http://localhost:11434/v1` (Ollama's default), and set the model to the one you pulled.
5. Before each item, set the relevant modes in the popup and settings page, and reopen the test tabs.

## A. Merging duplicates and undo

### A1. Merge duplicates in one window
- Steps: In settings, set the duplicate merging mode to "Suggest" ("提案") or "Automatic" ("自動") and turn off "Merge across windows" ("ウィンドウをまたいで統合する"). Open 3 tabs with the same URL (e.g. `https://example.com/`) in one window and press "Run now" ("今すぐ実行") in the popup (in suggest mode, apply the suggestion).
- Expected: Only 1 tab remains and the other 2 are closed. The popup shows how many tabs were closed.
- Result: Not run

### A2. Undo
- Steps: Right after A1, press "Undo" ("元に戻す") in the popup.
- Expected: The closed tabs are restored with their original URLs.
- Result: Not run

### A3. Pinned tabs are never closed
- Steps: Open 2 tabs with the same URL, pin one of them, and run.
- Expected: The pinned tab remains and only the other one is closed (pinned tabs are never closed).
- Result: Not run

### A4. The active tab is never closed
- Steps: Open 2 tabs with the same URL, make the duplicate the active tab, and run.
- Expected: The active tab is not closed.
- Result: Not run

### A5. Tabs playing audio are never closed
- Steps: Open 2 tabs of the same video/audio page, play one of them, and run.
- Expected: The tab playing audio is not closed.
- Result: Not run

### A6. Merge-across-windows setting
- Steps: Open two windows, each with a tab of the same URL. Run with "Merge across windows" ("ウィンドウをまたいで統合する") off, then with it on.
- Expected: With it off, neither tab is closed. With it on, the duplicates across windows are merged into one.
- Result: Not run

## B. Grouping

### B1. Apply a suggestion
- Steps: Set the grouping mode to "Suggest" ("提案"). Open several tabs from different domains (including at least one category with 2+ tabs of the same domain) and press "Run now" ("今すぐ実行"). Apply the suggestion shown in the popup.
- Expected: Tab groups are created as suggested (subject to the browser's tab group API support).
- Result: Not run

### B2. Discard a suggestion
- Steps: With the B1 suggestion showing, discard it.
- Expected: No tabs change and the suggestion disappears.
- Result: Not run

### B3. Add to an existing group
- Steps: With an existing group (e.g. one whose name matches a suggested category), open another tab of that category, run, and apply.
- Expected: No new group is created; the tab is added to the existing group.
- Result: Not run

### B4. A new category with a single tab is not grouped
- Steps: Open a tab whose domain no other tab shares, and run.
- Expected: No new group is created just for that tab.
- Result: Not run

### B5. Grouped tabs do not move
- Steps: With tabs you grouped manually, run and apply.
- Expected: Tabs already in a group are not moved to another group.
- Result: Not run

### B6. Close a tab after a suggestion is made, then apply (Review Focus 1)
- Steps: Create a suggestion (do not apply it). Manually close one or more tabs included in the suggestion, then apply it.
- Expected: The suggestion applies without errors and the closed tabs are skipped. The remaining tabs are handled as suggested.
- Result: Not run

## C. Auto mode

### C1. Switch to auto
- Steps: Set both the duplicate merging mode and the grouping mode to "Automatic" ("自動") and save. Open duplicate tabs and tabs to classify, then press "Run now" ("今すぐ実行").
- Expected: Tabs are closed and grouped automatically without suggestions, and the run is recorded in the run history.
- Result: Not run

## D. Scheduled runs

### D1. Wait while active, run when idle
- Steps: In settings, set the run interval (minutes) to 1 and the idle threshold (seconds) to 15, and save. Prepare duplicate tabs and keep using the computer for more than 1 minute. Then stop and leave it idle for 15+ seconds.
- Expected: Nothing runs while you are active. It runs after you become idle, and the run history records it with the "Scheduled" ("定期") trigger.
- Result: Not run

## E. Ollama (LLM)

### E1. The connection test lists models
- Steps: Start Ollama as described in Setup and press "Test connection" ("接続テスト") on the settings page.
- Expected: "Connected (N models)" ("接続しました（モデル N 件）") is shown, where N is the number of pulled models, and the pulled models appear as suggestions (datalist) in the model field.
- Result: Not run

### E2. Connect to a real Ollama and classify
- Steps: Enable the LLM and run with grouping set to "Suggest" ("提案").
- Expected: An LLM-based grouping suggestion appears. The popup's "LLM status" ("LLM の状態") shows OK.
- Result: Not run

### E3. Falls back to domain classification when Ollama is down, with a single notification
- Precondition: Run E2 first so the popup's "LLM status" ("LLM の状態") shows "OK" ("正常"). A notification is shown only when the status changes from OK to an error.
- Steps: Stop Ollama and run with the LLM still enabled. Then run a second time.
- Expected: It works using domain-based classification. The notification "Cannot reach the LLM. Switched to grouping by domain." ("LLM に接続できません。ドメイン単位の分類に切り替えました") appears once and does not repeat on the second run.
- Result: Not run

### E4. 403 message when OLLAMA_ORIGINS is not set
- Steps: Start `ollama serve` without `OLLAMA_ORIGINS` and press the connection test button on the settings page.
- Expected: An error makes clear that the response was 403 and that `OLLAMA_ORIGINS` must be set.
- Result: Not run

### E5. A run with a slow model and many tabs is still recorded to the end
- Steps: Configure a slow model (e.g. a larger model, or CPU inference) and set the timeout (seconds) to a large value such as 120. Open 50+ tabs to classify, press "Run now" ("今すぐ実行"), and wait until classification finishes (taking over a minute).
- Expected: The extension's background does not stop mid-run, and when classification finishes the run appears in "Run history" ("実行履歴") on the settings page (method: LLM or mixed).
- Result: Not run

## I. On-device AI

Use a fresh Firefox profile so no models are cached. I1–I3 were checked headless in Firefox 157 on 2026-10-11 with temporary probes (results below); the rest need a person.

### I1. Models load in the extension's Worker and stay cached
- Steps: Fresh profile, default settings. Run once, wait for the download, restart Firefox with the same profile, run again.
- Expected: The second session loads the models from the cache without downloading them again.
- Result: Pass (headless probe: 12 cached files after restart; load 8.4 s first, 3.3 s cached)

### I2. Download needs no host permission
- Steps: Check `about:addons` → Local LLM Tab Organizer → Permissions after the download.
- Expected: No website permissions were requested or granted.
- Result: Pass (headless probe: `permissions.getAll().origins` was empty)

### I3. First run falls back, second run groups by content
- Steps: Fresh profile, grouping "Auto" ("自動"). Open English and Japanese tabs on a few topics (e.g. GitHub pull requests, TypeScript docs, curry recipes in both languages, Japanese train timetables). Press "Run now" ("今すぐ実行"), wait for "Model: ready" ("モデル: 準備完了"), ungroup the tabs, press "Run now" again.
- Expected: The first run groups by domain and its history note says the model was not ready. The second run's method is "On-device AI" ("端末内 AI") and related tabs, including English and Japanese ones, share groups.
- Result: Pass (headless probe: first run `domain` + `modelNotReady`; download 20 s; second run `onDevice`, 10 tabs in 5 groups: "Developer", "Documentation", "カレー curry", "乗換 運行", "Wikipedia")

### I4. Download progress and status in the UI
- Steps: Fresh profile. Open the settings page and press "Download now" ("今すぐダウンロード"); open the popup while it downloads.
- Expected: The settings page and the popup show "Model: downloading… N%" rising to "Model: ready". "Download now" is disabled while downloading and once ready.
- Result: Not run

### I5. Offline download failure
- Steps: Fresh profile, go offline (File → Work Offline, or disconnect), press "Run now". Go back online and press "Download now".
- Expected: The run groups by domain; the status shows "Model: download failed (…)" and one notification "Could not download the on-device AI models…" appears. "Download now" then succeeds.
- Result: Not run

### I6. Delete downloaded models
- Steps: With the model ready, press "Delete downloaded models" ("ダウンロード済みモデルを削除").
- Expected: The status returns to "Model: not downloaded yet"; the next run downloads again.
- Result: Not run

### I7. Classification method switch
- Steps: On the settings page, select each classification method in turn.
- Expected: The LLM fields are enabled only for "Local LLM server"; saving with "On-device AI" or "By domain" asks for no permission. The popup's "Classification" ("分類") section follows the selected method.
- Result: Not run

## F. Undo (many tabs)

### F1. Close 26+ duplicates, then undo (Review Focus 5)
- Steps: Open 27+ tabs with the same URL and run duplicate merging so that 26+ are closed. Immediately press "Undo" ("元に戻す").
- Expected: All closed tabs come back. Firefox's recently closed list is searched only for the last 25 entries (the sessions API limit), so any beyond that are reopened as new tabs. The number of tabs restored still equals the number closed (not capped at the limit).
- Result: Not run

## G. Run history

### G1. Run history on the settings page
- Steps: After several runs from A, B, C, and D, open "Run history" ("実行履歴") on the settings page.
- Expected: The history is shown newest first, with columns for time, trigger, closed, grouped, method, and notes.
- Result: Not run

## H. Localization

### H1. UI follows the browser language
- Steps: With Firefox's UI language set to English, open the popup, the settings page, and trigger a notification (e.g. A1 in auto mode). Then set Firefox's language to Japanese (Settings → General → Language), restart Firefox, and repeat.
- Expected: In English, every label, message, and notification is English. In Japanese, they are all Japanese. Dates in the run history use the matching format. The extension name and description in about:addons follow the language as well.
- Result: Not run

## Lint results

Command: `npm run build:firefox && npx web-ext lint -s .output/firefox-mv3`

Date: 2026-10-11 (re-run after adding the on-device classifier)

Summary: errors 0 / warnings 3 / notices 0

Warnings added by the bundled ONNX Runtime (third-party code, not changed by us):

- `DANGEROUS_EVAL` in `ort/ort-wasm-simd-threaded.asyncify.mjs` (the Emscripten loader uses the `Function` constructor)
- `UNSAFE_VAR_ASSIGNMENT` in `assets/worker-*.js` (ONNX Runtime imports its WASM loader from a computed URL inside the extension)

AMO reviewers will see these; the submission notes should say they come from `onnxruntime-web` and that every loaded file is packaged in the extension.

Earlier summary (before the on-device classifier): errors 0 / warnings 1 / notices 0

The earlier `MISSING_DATA_COLLECTION_PERMISSIONS` warning was resolved by adding `browser_specific_settings.gecko.data_collection_permissions: { required: ["none"] }` to the manifest. Raising the minimum version to 140 also resolved the desktop `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` warning.

Remaining warning (verbatim):

- code: `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`
- message: Manifest key not supported by the specified minimum Firefox for Android version
- description: "strict_min_version" requires Firefox for Android 140, which was released before version 142 introduced support for "browser_specific_settings.gecko.data_collection_permissions".
- file: manifest.json

Errors: none

Note: Firefox for Android supports `data_collection_permissions` from 142. Whether to support Android (exclude it, or set the Android minimum to 142) will be decided when submitting to AMO.
