import { classifyByDomain } from '../core/classifyByDomain';
import type { Assignment, ClassifyMethod, LlmErrorKind, TabInfo } from '../core/types';
import { chatCompletion, LlmError, type ChatMessage } from './llmClient';
import type { Settings } from './settings';

const BATCH_SIZE = 50;
const MAX_GROUP_NAME = 40; // characters
/** Errors meaning the server cannot be reached at all; retrying the next batch would only wait again. */
const FATAL_KINDS: ReadonlySet<LlmErrorKind> = new Set(['unreachable', 'timeout', 'forbidden']);

export function parseAssignments(content: string, validTabIds: Set<number>): Assignment[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(content.slice(start, end + 1)); } catch { return []; }
  const list = (parsed as { assignments?: unknown } | null)?.assignments;
  if (!Array.isArray(list)) return [];
  const out: Assignment[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const { tabId, group } = item as { tabId?: unknown; group?: unknown };
    if (typeof tabId !== 'number' || !validTabIds.has(tabId) || seen.has(tabId)) continue;
    if (typeof group !== 'string' || group.trim() === '') continue;
    seen.add(tabId);
    out.push({ tabId, group: [...group.trim()].slice(0, MAX_GROUP_NAME).join('').trim() });
  }
  return out;
}

export interface ClassifyResult { assignments: Assignment[]; method: ClassifyMethod; error?: LlmErrorKind }

function uiLanguage(): string {
  try { return browser.i18n?.getUILanguage?.() ?? 'en'; } catch { return 'en'; }
}

function buildMessages(batch: TabInfo[], existingGroupNames: string[]): ChatMessage[] {
  const system =
    'タブを分類する。既存グループに合うならその名前をそのまま使う。' +
    '合わなければ短い名詞句で新しい名前を作る。' +
    `名前は ${uiLanguage()} で書く。` +
    '出力は {"assignments":[{"tabId":number,"group":string}]} の JSON だけ。\n' +
    `既存グループ: ${JSON.stringify(existingGroupNames)}`;
  const tabs = batch.map(t => ({ id: t.id, title: t.title, url: t.url })); // privacy: nothing else
  return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ tabs }) }];
}

/**
 * Rule: tabs are classified in batches of 50. A batch that throws LlmError, or tabs
 * the LLM leaves unassigned, are filled by classifyByDomain. After an unreachable /
 * timeout / forbidden error the LLM is not called again: every remaining tab is
 * classified by domain. method is 'llm' if every
 * tab came from the LLM, 'domain' if none did, otherwise 'mixed'. `error` is the
 * first LlmError kind seen. Non-LlmError exceptions propagate.
 */
export async function classifyTabs(
  tabs: TabInfo[], existingGroupNames: string[], cfg: Settings['llm'],
  chat: (messages: ChatMessage[]) => Promise<string> = m => chatCompletion(cfg, m),
): Promise<ClassifyResult> {
  if (!cfg.enabled) return { assignments: classifyByDomain(tabs), method: 'domain' };

  const assignments: Assignment[] = [];
  let error: LlmErrorKind | undefined;
  let llmCount = 0;
  let givenUp = false;
  for (let i = 0; i < tabs.length; i += BATCH_SIZE) {
    const batch = tabs.slice(i, i + BATCH_SIZE);
    let got: Assignment[] = [];
    if (!givenUp) {
      try {
        got = parseAssignments(await chat(buildMessages(batch, existingGroupNames)), new Set(batch.map(t => t.id)));
      } catch (e) {
        if (!(e instanceof LlmError)) throw e;
        error ??= e.kind;
        if (FATAL_KINDS.has(e.kind)) givenUp = true;
      }
    }
    assignments.push(...got);
    const done = new Set(got.map(a => a.tabId));
    const rest = batch.filter(t => !done.has(t.id));
    if (rest.length) assignments.push(...classifyByDomain(rest));
    llmCount += got.length;
  }
  const method: ClassifyMethod = llmCount === 0 ? 'domain' : llmCount === tabs.length ? 'llm' : 'mixed';
  return { assignments, method, ...(error ? { error } : {}) };
}
