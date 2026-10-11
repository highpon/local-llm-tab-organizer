# Manual Integration Test Checklist

Checks to run in a real Firefox. A person fills in every "Result" (all items are currently "Not run").

The extension's UI is in Japanese; UI labels are quoted in Japanese with an English gloss.

## Setup

1. Install dependencies: `npm install`
2. Start Firefox in development mode: `npx wxt -b firefox` (the extension is loaded as a temporary add-on)
3. Open the settings page from the "設定" (Settings) button in the popup. To shorten waits for the schedule checks, set the run interval (minutes) to 1 and the idle threshold (seconds) to 15, then save.
4. Extra setup for the LLM items (section E):
   - Install Ollama.
   - Start it with extension access allowed: `OLLAMA_ORIGINS=moz-extension://* ollama serve`
   - Pull a small model (e.g. `ollama pull qwen2.5:1.5b`).
   - On the settings page, turn on "LLM を使って分類する" (classify with an LLM), set the base URL to `http://localhost:11434/v1` (Ollama's default), and set the model to the one you pulled.
5. Before each item, set the relevant modes in the popup and settings page, and reopen the test tabs.

## A. Merging duplicates and undo

### A1. Merge duplicates in one window
- Steps: In settings, set the duplicate merging mode to "提案" (suggest) or "自動" (auto) and turn off "ウィンドウをまたいで統合する" (merge across windows). Open 3 tabs with the same URL (e.g. `https://example.com/`) in one window and press "今すぐ実行" (Run now) in the popup (in suggest mode, apply the suggestion).
- Expected: Only 1 tab remains and the other 2 are closed. The popup shows how many tabs were closed.
- Result: Not run

### A2. Undo
- Steps: Right after A1, press "元に戻す" (Undo) in the popup.
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
- Steps: Open two windows, each with a tab of the same URL. Run with "ウィンドウをまたいで統合する" (merge across windows) off, then with it on.
- Expected: With it off, neither tab is closed. With it on, the duplicates across windows are merged into one.
- Result: Not run

## B. Grouping

### B1. Apply a suggestion
- Steps: Set the grouping mode to "提案" (suggest). Open several tabs from different domains (including at least one category with 2+ tabs of the same domain) and press "今すぐ実行" (Run now). Apply the suggestion shown in the popup.
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
- Steps: Set both the duplicate merging mode and the grouping mode to "自動" (auto) and save. Open duplicate tabs and tabs to classify, then press "今すぐ実行" (Run now).
- Expected: Tabs are closed and grouped automatically without suggestions, and the run is recorded in the run history.
- Result: Not run

## D. Scheduled runs

### D1. Wait while active, run when idle
- Steps: In settings, set the run interval (minutes) to 1 and the idle threshold (seconds) to 15, and save. Prepare duplicate tabs and keep using the computer for more than 1 minute. Then stop and leave it idle for 15+ seconds.
- Expected: Nothing runs while you are active. It runs after you become idle, and the run history records it with the "定期" (scheduled) trigger.
- Result: Not run

## E. Ollama (LLM)

### E1. The connection test lists models
- Steps: Start Ollama as described in Setup and press "接続テスト" (connection test) on the settings page.
- Expected: "接続しました（モデル N 件）" (connected, N models) is shown, where N is the number of pulled models, and the pulled models appear as suggestions (datalist) in the model field.
- Result: Not run

### E2. Connect to a real Ollama and classify
- Steps: Enable the LLM and run with grouping set to "提案" (suggest).
- Expected: An LLM-based grouping suggestion appears. The popup's "LLM の状態" (LLM status) shows OK.
- Result: Not run

### E3. Falls back to domain classification when Ollama is down, with a single notification
- Precondition: Run E2 first so the popup's "LLM の状態" (LLM status) shows "正常" (OK). A notification is shown only when the status changes from OK to an error.
- Steps: Stop Ollama and run with the LLM still enabled. Then run a second time.
- Expected: It works using domain-based classification. The notification "LLM に接続できません。ドメイン単位の分類に切り替えました" (cannot reach the LLM; switched to domain classification) appears once and does not repeat on the second run.
- Result: Not run

### E4. 403 message when OLLAMA_ORIGINS is not set
- Steps: Start `ollama serve` without `OLLAMA_ORIGINS` and press the connection test button on the settings page.
- Expected: An error makes clear that the response was 403 and that `OLLAMA_ORIGINS` must be set.
- Result: Not run

### E5. A run with a slow model and many tabs is still recorded to the end
- Steps: Configure a slow model (e.g. a larger model, or CPU inference) and set the timeout (seconds) to a large value such as 120. Open 50+ tabs to classify, press "今すぐ実行" (Run now), and wait until classification finishes (taking over a minute).
- Expected: The extension's background does not stop mid-run, and when classification finishes the run appears in "実行履歴" (run history) on the settings page (method: LLM or mixed).
- Result: Not run

## F. Undo (many tabs)

### F1. Close 26+ duplicates, then undo (Review Focus 5)
- Steps: Open 27+ tabs with the same URL and run duplicate merging so that 26+ are closed. Immediately press "元に戻す" (Undo).
- Expected: All closed tabs come back. Firefox's recently closed list is searched only for the last 25 entries (the sessions API limit), so any beyond that are reopened as new tabs. The number of tabs restored still equals the number closed (not capped at the limit).
- Result: Not run

## G. Run history

### G1. Run history on the settings page
- Steps: After several runs from A, B, C, and D, open "実行履歴" (run history) on the settings page.
- Expected: The history is shown newest first, with columns for time, trigger, closed, grouped, method, and notes.
- Result: Not run

## Lint results

Command: `npm run build:firefox && npx web-ext lint -s .output/firefox-mv3`

Date: 2026-10-11 (re-run after raising the minimum version to 140)

Summary: errors 0 / warnings 1 / notices 0

The earlier `MISSING_DATA_COLLECTION_PERMISSIONS` warning was resolved by adding `browser_specific_settings.gecko.data_collection_permissions: { required: ["none"] }` to the manifest. Raising the minimum version to 140 also resolved the desktop `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` warning.

Remaining warning (verbatim):

- code: `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`
- message: Manifest key not supported by the specified minimum Firefox for Android version
- description: "strict_min_version" requires Firefox for Android 140, which was released before version 142 introduced support for "browser_specific_settings.gecko.data_collection_permissions".
- file: manifest.json

Errors: none

Note: Firefox for Android supports `data_collection_permissions` from 142. Whether to support Android (exclude it, or set the Android minimum to 142) will be decided when submitting to AMO.
