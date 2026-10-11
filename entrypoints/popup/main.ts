import type { DedupePlan, GroupingPlan } from '../../core/types';
import { loadPending } from '../../services/orchestrator';
import { listRuns, type RunRecord } from '../../services/runHistory';
import type { Message } from '../../services/scheduler';
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
    return g.title || '既存グループ';
  } catch {
    return '既存グループ';
  }
}

function actions(kind: 'dedupe' | 'grouping'): HTMLDivElement {
  const div = el('div');
  const apply = el('button', '適用');
  const discard = el('button', '破棄');
  const act = (type: 'applyPending' | 'discardPending') => async () => {
    apply.disabled = discard.disabled = true;
    try {
      await send({ type, kind });
      setMessage(type === 'applyPending' ? '適用しました' : '破棄しました');
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
  sec.append(el('h2', '重複の統合（閉じるタブ）'), ul, actions('dedupe'));
  return sec;
}

async function renderGrouping(plan: GroupingPlan): Promise<HTMLElement | null> {
  const sec = el('section');
  sec.append(el('h2', 'グループ分けの提案'));
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
  const when = new Date(r.at).toLocaleString('ja-JP');
  if (r.skipped) return `${when}: 他の実行中のためスキップ`;
  const base = `${when}: 閉じた ${r.closed} 件 / グループ化 ${r.grouped} 件`;
  return r.error ? `${base}（エラー: ${r.error}）` : base;
}

const LLM_TEXT: Record<string, string> = {
  ok: '正常',
  unreachable: '接続できません',
  timeout: 'タイムアウトしました',
  forbidden: '接続が拒否されました（OLLAMA_ORIGINS の設定が必要です）',
  http: 'サーバーがエラーを返しました',
  badResponse: '応答を解釈できませんでした',
};

async function render(): Promise<void> {
  const [pending, undo, runs, status] = await Promise.all([
    loadPending(),
    loadUndo(),
    listRuns(),
    browser.storage.local.get('llmStatus'),
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

  $('last').textContent = runs[0] ? describeRun(runs[0]) : 'まだ実行されていません';

  const llm = $('llm');
  llm.replaceChildren();
  const st = status.llmStatus as string | undefined;
  if (st === undefined) {
    llm.textContent = '未使用';
  } else {
    llm.append(el('span', LLM_TEXT[st] ?? st));
    if (st !== 'ok') {
      llm.append(' ');
      const link = el('a', '設定を開く');
      link.href = '#';
      link.addEventListener('click', (ev) => {
        ev.preventDefault();
        void browser.runtime.openOptionsPage();
      });
      llm.append(link);
    }
  }
}

$('run').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('run');
  btn.disabled = true;
  setMessage('実行中...');
  try {
    const r = (await send({ type: 'runNow' })) as RunRecord | undefined;
    setMessage(r ? describeRun(r) : '完了しました', !!r?.error);
  } catch (e) {
    setMessage(String(e), true);
  }
  btn.disabled = false;
  await render();
});

$('undo').addEventListener('click', async () => {
  try {
    const r = (await send({ type: 'undo' })) as { restored: number; ungrouped: number } | undefined;
    setMessage(r ? `復元 ${r.restored} 件 / グループ解除 ${r.ungrouped} 件` : '元に戻しました');
  } catch (e) {
    setMessage(String(e), true);
  }
  await render();
});

$('options').addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

void render();
