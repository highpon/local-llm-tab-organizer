import type { Mode } from '../../core/types';
import { formatTime, localizeDocument, t } from '../../services/i18n';
import { LlmError, listModels } from '../../services/llmClient';
import { listRuns } from '../../services/runHistory';
import type { Message } from '../../services/scheduler';
import { loadSettings, saveSettings, type Settings } from '../../services/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const modeLabels = (): [Mode, string][] => [['auto', t('modeAuto')], ['suggest', t('modeSuggest')], ['off', t('modeOff')]];
const triggerLabels = () => ({ alarm: t('triggerAlarm'), idle: t('triggerIdle'), manual: t('triggerManual') });
const methodLabels = () => ({
  llm: t('methodLlm'), onDevice: t('methodOnDevice'), domain: t('methodDomain'), mixed: t('methodMixed'),
});

const errorText = (kind: string): string | undefined => ({
  unreachable: t('errUnreachable'),
  timeout: t('errTimeout'),
  forbidden: t('ollamaGuide'),
  http: t('errHttp'),
  badResponse: t('errBadResponse'),
} as Record<string, string>)[kind];

function fillModes(select: HTMLSelectElement): void {
  for (const [value, label] of modeLabels()) {
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
  $<HTMLInputElement>('llmEnabled').checked = s.classifier === 'llm';
  $<HTMLInputElement>('baseUrl').value = s.llm.baseUrl;
  $<HTMLInputElement>('model').value = s.llm.model;
  $<HTMLInputElement>('timeoutSeconds').value = String(s.llm.timeoutSeconds);
  $<HTMLInputElement>('intervalMinutes').value = String(s.schedule.intervalMinutes);
  $<HTMLInputElement>('idleSeconds').value = String(s.schedule.idleSeconds);
}

function readInt(id: string, min: number, field: string): number {
  const raw = $<HTMLInputElement>(id).value.trim();
  const n = Number(raw);
  if (raw === '' || !Number.isInteger(n) || n < min) {
    throw new Error(t('intRequired', field, min));
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
    classifier: $<HTMLInputElement>('llmEnabled').checked ? 'llm' : 'onDevice',
    llm: {
      baseUrl: $<HTMLInputElement>('baseUrl').value.trim(),
      model: $<HTMLInputElement>('model').value.trim(),
      timeoutSeconds: readInt('timeoutSeconds', 1, t('fieldTimeout')),
    },
    schedule: {
      intervalMinutes: readInt('intervalMinutes', 1, t('fieldInterval')),
      idleSeconds: readInt('idleSeconds', 15, t('fieldIdle')),
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
      formatTime(r.at),
      triggerLabels()[r.trigger],
      String(r.closed),
      String(r.grouped),
      r.method ? methodLabels()[r.method] : '-',
      r.skipped ? t('skipped') : r.error ?? '',
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
  if (!pattern) return show('testResult', t('invalidBaseUrl'), true);
  show('testResult', t('connecting'), false);
  try {
    const granted = await browser.permissions.request({ origins: [pattern] });
    if (!granted) return show('testResult', t('permissionDenied'), true);
    const timeoutSeconds = Math.max(1, Number($<HTMLInputElement>('timeoutSeconds').value) || 30);
    const models = await listModels({
      baseUrl, model: '', timeoutSeconds,
    });
    const list = $('models');
    list.replaceChildren();
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m;
      list.append(o);
    }
    show('testResult', t('connected', models.length), false);
  } catch (e) {
    const kind = e instanceof LlmError ? e.kind : 'unreachable';
    show('testResult', errorText(kind) ?? String(e), true);
  }
});

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const enabled = $<HTMLInputElement>('llmEnabled').checked;
  const baseUrl = $<HTMLInputElement>('baseUrl').value.trim();
  const pattern = originPattern(baseUrl);
  if (enabled && !pattern) return show('status', t('invalidBaseUrl'), true);
  if (enabled && $<HTMLInputElement>('model').value.trim() === '') {
    return show('status', t('modelRequired'), true);
  }
  try {
    let granted = true;
    if (enabled && pattern) granted = await browser.permissions.request({ origins: [pattern] });
    if (!granted) {
      $<HTMLInputElement>('llmEnabled').checked = false;
      return show('status', t('llmPermissionDenied'), true);
    }
    const s = readForm();
    await saveSettings(s);
    await browser.runtime.sendMessage({ type: 'settingsChanged' } satisfies Message);
    show('status', t('saved'), false);
  } catch (e) {
    show('status', e instanceof Error ? e.message : String(e), true);
  }
});

async function init(): Promise<void> {
  localizeDocument();
  fillModes($('dedupeMode'));
  fillModes($('groupingMode'));
  fillForm(await loadSettings());
  await renderHistory();
}
void init();
