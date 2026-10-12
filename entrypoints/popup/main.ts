import type { DedupePlan, GroupingPlan } from '../../core/types';
import { formatTime, localizeDocument, t } from '../../services/i18n';
import { loadModelStatus, MODEL_STATUS_KEY, modelStatusText } from '../../services/modelManager';
import { loadPending } from '../../services/pending';
import { listRuns, type RunRecord } from '../../services/runHistory';
import type { Message } from '../../services/scheduler';
import { loadSettings } from '../../services/settings';
import { loadUndo } from '../../services/undoLog';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const send = (m: Message): Promise<unknown> => browser.runtime.sendMessage(m);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

function setMessage(text: string, isError = false): void {
  const m = $('message');
  m.textContent = text;
  m.className = isError ? 'error' : 'muted';
}

async function tabTitle(id: number, fallbackUrl: string): Promise<string | null> {
  try {
    const t = await browser.tabs.get(id);
    return t.title || t.url || fallbackUrl;
  } catch {
    return null; // tab no longer exists
  }
}

async function tabList(tabs: { tabId: number; url: string }[]): Promise<HTMLUListElement | null> {
  const ul = el('ul');
  for (const t of tabs) {
    const title = await tabTitle(t.tabId, t.url);
    if (title !== null) ul.append(el('li', title));
  }
  return ul.children.length > 0 ? ul : null;
}

async function groupTitle(groupId: number): Promise<string> {
  try {
    const g = await browser.tabGroups.get(groupId);
    return g.title || t('existingGroup');
  } catch {
    return t('existingGroup');
  }
}

function actions(kind: 'dedupe' | 'grouping'): HTMLDivElement {
  const div = el('div');
  const apply = el('button', t('apply'));
  const discard = el('button', t('discard'));
  const act = (type: 'applyPending' | 'discardPending') => async () => {
    apply.disabled = discard.disabled = true;
    try {
      const res = await send({ type, kind });
      if (res === 'busy') setMessage(t('busy'));
      else setMessage(type === 'applyPending' ? t('applied') : t('discarded'));
    } catch (e) {
      setMessage(String(e), true);
    }
    await render();
  };
  apply.addEventListener('click', act('applyPending'));
  discard.addEventListener('click', act('discardPending'));
  div.append(apply, discard);
  return div;
}

async function renderDedupe(plan: DedupePlan): Promise<HTMLElement | null> {
  const ul = await tabList(plan.closes.map((c) => ({ tabId: c.tabId, url: c.url })));
  if (!ul) return null;
  const sec = el('section');
  sec.append(el('h2', t('dedupeHeading')), ul, actions('dedupe'));
  return sec;
}

async function renderGrouping(plan: GroupingPlan): Promise<HTMLElement | null> {
  const sec = el('section');
  sec.append(el('h2', t('groupingHeading')));
  let any = false;
  const entries: { title: string; tabs: { tabId: number; url: string }[] }[] = [];
  for (const g of plan.createNew) entries.push({ title: g.title, tabs: g.tabs.map((t) => ({ tabId: t.tabId, url: t.url })) });
  for (const g of plan.addToExisting) {
    entries.push({ title: await groupTitle(g.groupId), tabs: g.tabs.map((t) => ({ tabId: t.tabId, url: t.url })) });
  }
  for (const e of entries) {
    const ul = await tabList(e.tabs);
    if (!ul) continue;
    any = true;
    sec.append(el('div', e.title), ul);
  }
  if (!any) return null;
  sec.append(actions('grouping'));
  return sec;
}

function describeRun(r: RunRecord): string {
  const when = formatTime(r.at);
  if (r.skipped) return t('runSkipped', when);
  const base = t('runSummary', when, r.closed, r.grouped);
  return r.error ? t('runWithError', base, r.error) : base;
}

const llmText = (status: string): string => ({
  ok: t('llmOk'),
  unreachable: t('llmUnreachable'),
  timeout: t('llmTimeout'),
  forbidden: t('llmForbidden'),
  http: t('llmHttp'),
  badResponse: t('llmBadResponse'),
} as Record<string, string>)[status] ?? status;

async function render(): Promise<void> {
  const [pending, undo, runs, status, settings, model] = await Promise.all([
    loadPending(),
    loadUndo(),
    listRuns(),
    browser.storage.local.get('llmStatus'),
    loadSettings(),
    loadModelStatus(),
  ]);

  $<HTMLButtonElement>('undo').disabled = undo === null;

  const pendingEl = $('pending');
  pendingEl.replaceChildren();
  if (pending?.dedupe) {
    const s = await renderDedupe(pending.dedupe);
    if (s) pendingEl.append(s);
  }
  if (pending?.grouping) {
    const s = await renderGrouping(pending.grouping);
    if (s) pendingEl.append(s);
  }

  $('last').textContent = runs[0] ? describeRun(runs[0]) : t('neverRun');

  const box = $('classify');
  box.replaceChildren();
  const settingsLink = (): HTMLAnchorElement => {
    const link = el('a', t('openSettings'));
    link.href = '#';
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      void browser.runtime.openOptionsPage();
    });
    return link;
  };
  if (settings.classifier === 'onDevice') {
    box.append(el('span', modelStatusText(model)));
    if (model.state === 'error') box.append(' ', settingsLink());
  } else if (settings.classifier === 'llm') {
    const st = status.llmStatus as string | undefined;
    if (st === undefined) {
      box.textContent = t('llmUnused');
    } else {
      box.append(el('span', llmText(st)));
      if (st !== 'ok') box.append(' ', settingsLink());
    }
  } else {
    box.textContent = t('classifyByDomainStatus');
  }
}

// Download progress updates while the popup is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[MODEL_STATUS_KEY]) void render();
});

$('run').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('run');
  btn.disabled = true;
  setMessage(t('running'));
  try {
    const r = (await send({ type: 'runNow' })) as RunRecord | undefined;
    setMessage(r ? describeRun(r) : t('done'), !!r?.error);
  } catch (e) {
    setMessage(String(e), true);
  }
  btn.disabled = false;
  await render();
});

$('undo').addEventListener('click', async () => {
  $<HTMLButtonElement>('undo').disabled = true; // render() re-enables it only if a record remains
  try {
    const r = (await send({ type: 'undo' })) as { restored: number; ungrouped: number } | undefined;
    setMessage(r ? t('undoResult', r.restored, r.ungrouped) : t('undone'));
  } catch (e) {
    setMessage(String(e), true);
  }
  await render();
});

$('options').addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

localizeDocument();
void render();
