import type { Mode } from '../../core/types';
import { LlmError, listModels } from '../../services/llmClient';
import { listRuns } from '../../services/runHistory';
import type { Message } from '../../services/scheduler';
import { loadSettings, saveSettings, type Settings } from '../../services/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const MODE_LABELS: [Mode, string][] = [['auto', '自動'], ['suggest', '提案'], ['off', 'オフ']];
const TRIGGER_LABELS = { alarm: '定期', idle: 'アイドル', manual: '手動' } as const;
const METHOD_LABELS = { llm: 'LLM', domain: 'ドメイン', mixed: '混合' } as const;

const OLLAMA_GUIDE =
  'Ollama が拡張機能からの接続を拒否しました。環境変数 OLLAMA_ORIGINS=moz-extension://* を設定して Ollama を再起動してください。';
const ERROR_TEXT: Record<string, string> = {
  unreachable: 'サーバーに接続できません。URL と Ollama の起動状態を確認してください。',
  timeout: 'タイムアウトしました。',
  forbidden: OLLAMA_GUIDE,
  http: 'サーバーがエラーを返しました。',
  badResponse: '応答を解釈できませんでした。',
};

function fillModes(select: HTMLSelectElement): void {
  for (const [value, label] of MODE_LABELS) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.append(o);
  }
}

function show(id: string, text: string, isError: boolean): void {
  const e = $(id);
  e.textContent = text;
  e.className = isError ? 'error' : 'muted';
}

function fillForm(s: Settings): void {
  $<HTMLSelectElement>('dedupeMode').value = s.dedupe.mode;
  $<HTMLInputElement>('acrossWindows').checked = s.dedupe.acrossWindows;
  $<HTMLSelectElement>('groupingMode').value = s.grouping.mode;
  $<HTMLInputElement>('llmEnabled').checked = s.llm.enabled;
  $<HTMLInputElement>('baseUrl').value = s.llm.baseUrl;
  $<HTMLInputElement>('model').value = s.llm.model;
  $<HTMLInputElement>('timeoutSeconds').value = String(s.llm.timeoutSeconds);
  $<HTMLInputElement>('intervalMinutes').value = String(s.schedule.intervalMinutes);
  $<HTMLInputElement>('idleSeconds').value = String(s.schedule.idleSeconds);
}

function readInt(id: string, min: number, label: string): number {
  const raw = $<HTMLInputElement>(id).value.trim();
  const n = Number(raw);
  if (raw === '' || !Number.isInteger(n) || n < min) {
    throw new Error(`${label}は ${min} 以上の整数を入力してください。`);
  }
  return n;
}

function readForm(): Settings {
  return {
    dedupe: {
      mode: $<HTMLSelectElement>('dedupeMode').value as Mode,
      acrossWindows: $<HTMLInputElement>('acrossWindows').checked,
    },
    grouping: { mode: $<HTMLSelectElement>('groupingMode').value as Mode },
    llm: {
      enabled: $<HTMLInputElement>('llmEnabled').checked,
      baseUrl: $<HTMLInputElement>('baseUrl').value.trim(),
      model: $<HTMLInputElement>('model').value.trim(),
      timeoutSeconds: readInt('timeoutSeconds', 1, 'タイムアウト'),
    },
    schedule: {
      intervalMinutes: readInt('intervalMinutes', 1, '実行間隔'),
      idleSeconds: readInt('idleSeconds', 15, 'アイドル判定'),
    },
  };
}

/** Origin match pattern for baseUrl, or null when the URL is invalid. */
function originPattern(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin + '/*';
  } catch {
    return null;
  }
}

async function renderHistory(): Promise<void> {
  const body = $('history');
  body.replaceChildren();
  for (const r of await listRuns()) {
    const tr = document.createElement('tr');
    const cells = [
      new Date(r.at).toLocaleString('ja-JP'),
      TRIGGER_LABELS[r.trigger],
      String(r.closed),
      String(r.grouped),
      r.method ? METHOD_LABELS[r.method] : '-',
      r.skipped ? 'スキップ' : r.error ?? '',
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    body.append(tr);
  }
}

// Handlers call permissions.request before any other await so it stays within the user gesture.
$('test').addEventListener('click', async () => {
  const baseUrl = $<HTMLInputElement>('baseUrl').value.trim();
  const pattern = originPattern(baseUrl);
  if (!pattern) return show('testResult', 'ベース URL が正しくありません。', true);
  show('testResult', '接続中...', false);
  try {
    const granted = await browser.permissions.request({ origins: [pattern] });
    if (!granted) return show('testResult', 'この URL への接続が許可されませんでした。', true);
    const timeoutSeconds = Math.max(1, Number($<HTMLInputElement>('timeoutSeconds').value) || 30);
    const models = await listModels({
      enabled: true, baseUrl, model: '', timeoutSeconds,
    });
    const list = $('models');
    list.replaceChildren();
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m;
      list.append(o);
    }
    show('testResult', `接続しました（モデル ${models.length} 件）`, false);
  } catch (e) {
    const kind = e instanceof LlmError ? e.kind : 'unreachable';
    show('testResult', ERROR_TEXT[kind] ?? String(e), true);
  }
});

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const enabled = $<HTMLInputElement>('llmEnabled').checked;
  const baseUrl = $<HTMLInputElement>('baseUrl').value.trim();
  const pattern = originPattern(baseUrl);
  if (enabled && !pattern) return show('status', 'ベース URL が正しくありません。', true);
  try {
    let granted = true;
    if (enabled && pattern) granted = await browser.permissions.request({ origins: [pattern] });
    if (!granted) {
      $<HTMLInputElement>('llmEnabled').checked = false;
      return show('status', 'LLM の接続先が許可されなかったため、LLM は有効にしていません。', true);
    }
    const s = readForm();
    await saveSettings(s);
    await browser.runtime.sendMessage({ type: 'settingsChanged' } satisfies Message);
    show('status', '保存しました', false);
  } catch (e) {
    show('status', e instanceof Error ? e.message : String(e), true);
  }
});

async function init(): Promise<void> {
  fillModes($('dedupeMode'));
  fillModes($('groupingMode'));
  fillForm(await loadSettings());
  await renderHistory();
}
void init();
