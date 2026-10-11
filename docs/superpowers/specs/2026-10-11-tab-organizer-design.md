# tab-tidy Design

- Date: 2026-10-11
- Status: awaiting review

## 1. Purpose

**tab-tidy** is a Firefox extension that automatically tidies open tabs on a schedule. It will be published on Firefox Add-ons (AMO).

Problems it solves:

- A. Too many tabs to find the one you want → classify them so they are easier to scan
- B. Too many tabs slow the browser down → merge duplicate tabs to reduce the count
- C. Research sessions scatter tabs everywhere → collect them into tab groups by topic

### Success criteria

- Right after installation, duplicate merging and domain-based grouping work without any LLM
- With a local LLM configured (Ollama, LM Studio, or another OpenAI-compatible API), grouping is based on content
- The user never loses a tab unintentionally (conservative exclusion rules, re-validation right before acting, undo)
- Tabs do not move while the user is working (scheduled runs happen only while the user is idle)

### Differentiation

Compared with similar extensions (e.g. Smart Tab Groups) and Firefox's built-in AI tab group suggestions, tab-tidy differs in three ways:

1. Automatic periodic runs
2. Merging duplicate tabs
3. Using a local LLM of the user's choice

## 2. Summary of decisions

| Item | Decision |
|---|---|
| LLM | Not required. Rule-based by default, with optional support for a local server the user runs (OpenAI-compatible `/v1/chat/completions`) |
| How groups are shown | Firefox native tab groups (`tabs.group` / `tabGroups.update`) |
| Duplicate detection | Normalized URLs are equal |
| Which tab to keep | The tab with the most recent `lastAccessed` |
| Automation level | Each feature can be set to "auto" or "suggest". Defaults: duplicate merging is auto, grouping is suggest |
| When to run | At a fixed interval, and only while the user is idle. Defaults: every 30 minutes, after 60 seconds of inactivity. A "Run now" action is also provided |
| How categories are chosen | Prefer existing tab groups; create a new group only when 2 or more tabs don't fit any existing group |
| Tech stack | TypeScript + WXT (Manifest V3), Vitest |
| Minimum version | Firefox 140 (`tabGroups.update` is available from 139, `data_collection_permissions` from 140) |

## 3. Architecture

The core principle is to separate "making a plan" (pure logic) from "carrying it out" (browser APIs). In auto mode a plan is executed immediately; in suggest mode it is saved and waits for the user's approval.

```
entrypoints/
  background.ts       Startup only. Wires the scheduler to the orchestrator
  popup/              Run now, apply/discard suggestions, undo, LLM connection status
  options/            Settings page (LLM endpoint, model, connection test, modes, interval, run history)

core/                 No browser API dependencies
  types.ts            TabInfo, GroupInfo, DedupePlan, GroupingPlan, etc.
  normalizeUrl.ts     URL normalization
  planDedupe.ts       Tab list → plan of tabs to close
  classifyByDomain.ts Domain-based classification used without an LLM
  planGrouping.ts     Classification + existing groups → grouping plan

services/             Talks to the browser and the outside world
  tabsAdapter.ts      Reads browser.tabs / tabGroups and executes plans
  llmClient.ts        Calls OpenAI-compatible /v1/chat/completions (with a timeout)
  llmClassifier.ts    Builds the prompt and validates the JSON response. Falls back to classifyByDomain on failure
  scheduler.ts        Combines alarms and idle detection
  settings.ts         Saves and loads settings in storage.local (including defaults)
  undoLog.ts          Records the last run's operations and undoes them
  runHistory.ts       History of run results (last 20)
  orchestrator.ts     One run (read → plan → execute if auto, save if suggest)
```

### Permissions

- `tabs`, `tabGroups`, `alarms`, `idle`, `storage`, `notifications`, `sessions`
- Host permissions for the LLM endpoint are declared in `optional_host_permissions` and requested with `permissions.request` when the user configures the endpoint

### Privacy

- Only tab titles and URLs are sent to the LLM. Page contents are never read
- Data is sent only to the LLM server the user configures, and nowhere else
- With the on-device classifier (the default, see [`2026-10-11-on-device-classifier-design.md`](2026-10-11-on-device-classifier-design.md)) no tab data leaves the device; the only requests are GETs for model files on huggingface.co

## 4. Data flow

### 4.1 Triggering a run

1. `alarms` fires every `intervalMinutes` (default 30 minutes)
2. If `idle.queryState(idleSeconds)` (default 60 seconds) returns `idle` or `locked`, run immediately. If it returns `active`, set a "run pending" flag in `storage.session`
3. When `idle.onStateChanged` reports `idle`, run if the pending flag is set, then clear it
4. "Run now" in the popup skips the idle check and runs immediately
5. While running, hold a lock in `storage.session` so two runs never overlap. The lock expires after 5 minutes
6. On `runtime.onStartup` and `runtime.onInstalled`, recreate the alarm if it is missing

### 4.2 Merging duplicates (`planDedupe`)

1. Get `TabInfo` for all tabs
2. Exclude: non-`http:`/`https:` tabs, pinned tabs, the active tab of each window, and tabs playing audio
3. Group by normalized URL. If `dedupeAcrossWindows` is false (the default), group per window
4. In each group of 2 or more, keep the tab with the most recent `lastAccessed` and plan to close the rest
5. In auto mode, execute and record in `undoLog`. In suggest mode, save the plan and notify

### 4.3 URL normalization (`normalizeUrl`)

- Drop the `#` fragment
- Drop tracking parameters: `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref_src` (`ref` is kept because it carries meaning, e.g. a branch on GitHub)
- Sort the remaining query parameters by key
- Strip a trailing `/` (a path of just `/` is treated as empty)
- Treat `http` and `https` as the same
- Strip a leading `www.` from the host and lowercase it
- Keep all other query parameters (e.g. search results with different terms, or videos with a different `?v=`, are different pages)

### 4.4 Grouping (`planGrouping`)

1. After merging duplicates, fetch tabs and tab groups again
2. **Tabs already in a group are never moved.** Only `http(s)` tabs that are not in any group are classified (pinned tabs are also excluded)
3. Classification:
   - If the LLM is enabled, use `llmClassifier`. Send the names of existing groups and `{id, title, url}` for each ungrouped tab, and ask for `{"assignments":[{"tabId":number,"group":string}]}`. `group` is either an existing group name or a new name (a short noun phrase in the browser's UI language). Send at most 50 tabs per request
   - If the LLM is disabled or fails, use `classifyByDomain`. Strip `www.` from the host and group by registrable domain (e.g. `docs.github.com` → `github.com`). Use the main part of the domain as the group name (e.g. `GitHub`)
4. Build the plan:
   - If an assignment matches the name of an existing group, add the tab to that group even if it is the only one (only groups in the same window)
   - For a new group name, create the group only when 2 or more tabs in the same window share it. A single tab is left as is
5. In suggest mode (the default), save the plan, send a notification, and let the user choose Apply or Discard in the popup. In auto mode, create groups with `tabs.group` and name them with `tabGroups.update`. Colors are left to Firefox's defaults

### 4.5 Undo (`undoLog`)

- Only the most recent run is recorded
- Closed tabs are matched to session IDs via `sessions.getRecentlyClosed` and restored with `sessions.restore`
- Tabs added to groups are returned to ungrouped with `tabs.ungroup`. Groups created by tab-tidy disappear automatically once they have no tabs

## 5. Error handling

Principle: failures must never lose tabs. Fall back to the safe option, quietly.

### LLM

| Situation | Response |
|---|---|
| Cannot connect | Use domain classification for that run. Show the status in the popup. Notify only once, when the status changes |
| Timeout (default 30 seconds, configurable) | Fall back to domain classification |
| Invalid JSON, unknown tabId, or out-of-scope tabId | Discard only the invalid parts; classify unassigned tabs by domain |
| HTTP 403 | Explain that `OLLAMA_ORIGINS=moz-extension://*` is probably missing and show how to set it |

### Tab operations

| Situation | Response |
|---|---|
| Tab state changed after the plan was made | Right before acting, re-check existence, URL, pinned, active, and group membership; skip tabs whose conditions changed. The same applies when applying a suggestion |
| `tabs.remove` / `tabs.group` partly fails | Skip the failed tabs and continue. Record only the successful ones in `undoLog` |
| `tabGroups` API is missing | `strict_min_version: "140.0"` in the manifest prevents installation. Also check for the API at runtime; if it is missing, disable grouping and run duplicate merging only |

### Scheduler

| Situation | Response |
|---|---|
| The background page is unloaded mid-run | Recover through lock expiry (5 minutes) |
| The browser restarts | Recreate the alarm in `onStartup` |

### Run history

Keep the result of each run (time, trigger, tabs closed, tabs grouped, classification method, error) in `storage.local`, up to the last 20, and show it on the settings page.

## 6. Settings

| Key | Default | Description |
|---|---|---|
| `dedupe.mode` | `auto` | `auto` / `suggest` / `off` |
| `dedupe.acrossWindows` | `false` | Whether to look for duplicates across windows |
| `grouping.mode` | `suggest` | `auto` / `suggest` / `off` |
| `classifier` | `onDevice` | `onDevice` / `llm` / `domain`. Replaces `llm.enabled` (stored `true` migrates to `llm`) |
| `llm.baseUrl` | `http://localhost:11434/v1` | Base URL of the OpenAI-compatible API |
| `llm.model` | (empty) | Model name. The connection test lists candidates from `/v1/models` |
| `llm.timeoutSeconds` | `30` | Timeout per request |
| `schedule.intervalMinutes` | `30` | Interval between scheduled runs |
| `schedule.idleSeconds` | `60` | Seconds of inactivity before the user counts as idle (the `idle` API minimum is 15 seconds) |

## 7. Testing

### Unit tests (Vitest, the main focus)

- `normalizeUrl`: both cases that must be treated as the same and cases that must not
- `planDedupe`: keeps the most recent `lastAccessed`, exclusion rules, with and without cross-window merging
- `planGrouping`: prefers existing groups, no new group for fewer than 2 tabs, never moves grouped tabs, window boundaries
- `classifyByDomain`: subdomain handling, group name generation

### Service layer (Vitest, browser APIs mocked with `@webext-core/fake-browser`)

- `llmClassifier`: falls back to domain classification as expected for a normal response, broken JSON, unknown tabId, timeout, and 403 (`fetch` is mocked)
- `orchestrator`: re-validation right before acting, locking and lock expiry, auto vs. suggest branches
- `scheduler`: waits while the user is active and runs once they become `idle`
- `undoLog`: restoring closed tabs and undoing grouping

### Manual integration checks (real Firefox)

Load the extension in WXT development mode and check the following:

- Merging duplicate tabs and undo
- Grouping suggestions: apply and discard
- Connecting to a real Ollama instance and classifying
- Falling back to domain classification when Ollama is not running
- The 403 message when `OLLAMA_ORIGINS` is not set
- `web-ext lint` passes before submitting to the store

## 8. Out of scope (future candidates)

- LLM-based content duplicate detection (suggestions only)
- Triggering runs by tab count thresholds
- A sidebar listing categories
- E2E automation with Playwright or similar
