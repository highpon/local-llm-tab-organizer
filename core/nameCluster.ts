import type { TabInfo } from './types';

const MAX_GROUP_NAME = 40; // characters (code points)
const MAX_TOPIC_TITLES = 3;
const SITE_SEPARATORS = [' - ', ' | ', ' — '];
const REJECTED_LABELS = new Set(['none', 'adult content', '']);

const STOPWORDS = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as',
  'is', 'are', 'be', 'it', 'its', 'this', 'that', 'how', 'what', 'why', 'when', 'your', 'you', 'my',
  // Japanese
  'する', 'こと', 'もの', 'ため', 'これ', 'それ', 'よう', 'さん', 'について', 'から', 'まで',
  // generic web words
  'home', 'page', 'login', 'sign', 'search', 'ログイン', 'トップ', 'ホーム',
]);

/** Trim and cut to 40 code points, never splitting a surrogate pair. */
export function clipGroupName(name: string): string {
  return [...name.trim()].slice(0, MAX_GROUP_NAME).join('').trim();
}

/** Drops a trailing " - Site" / " | Site" / " — Site" when something is left before it. */
export function stripSiteSuffix(title: string): string {
  let cut = -1;
  for (const sep of SITE_SEPARATORS) cut = Math.max(cut, title.lastIndexOf(sep));
  if (cut <= 0) return title;
  const head = title.slice(0, cut).trim();
  return head === '' ? title : head;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Text embedded for a tab: the title without its site suffix plus the hostname. */
export function embedText(tab: TabInfo): string {
  const host = hostname(tab.url);
  const title = tab.title.trim();
  // Unloaded or untitled tabs show their URL as the title; it carries nothing the hostname does not.
  if (title === '' || title === tab.url || /^[a-z][a-z0-9+.-]*:\/\//i.test(title)) return host;
  return `${stripSiteSuffix(title)} ${host}`.trim();
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const s of segmenter.segment(text.toLowerCase())) {
    if (!s.isWordLike) continue;
    const w = s.segment;
    if ([...w].length < 2 || /^\p{N}+$/u.test(w) || STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

/** Top `n` c-TF-IDF terms per cluster; each cluster's titles form one document. */
export function clusterKeywords(clusters: string[][], n: number): string[][] {
  const docs = clusters.map((titles) => titles.flatMap(tokenize));
  const totalTf = new Map<string, number>();
  for (const doc of docs) for (const w of doc) totalTf.set(w, (totalTf.get(w) ?? 0) + 1);
  const avgWords = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, docs.length);
  return docs.map((doc) => {
    const tf = new Map<string, number>(); // insertion order = first occurrence, used for ties
    for (const w of doc) tf.set(w, (tf.get(w) ?? 0) + 1);
    return [...tf]
      .map(([w, f]) => ({ w, score: f * Math.log(1 + avgWords / totalTf.get(w)!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((x) => x.w);
  });
}

function isLatinTitle(title: string): boolean {
  const letters = title.match(/\p{L}/gu) ?? [];
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return latin * 2 > letters.length;
}

/** True when a strict majority of titles are mostly Latin letters. */
export function isMostlyLatin(titles: string[]): boolean {
  return titles.filter(isLatinTitle).length * 2 > titles.length;
}

/** The input format Mozilla/smart-tab-topic was trained on. */
export function topicPrompt(keywords: string[], titles: string[]): string {
  return `Topic from keywords: ${keywords.join(',')}. titles: \n${titles.slice(0, MAX_TOPIC_TITLES).join('\n')}`;
}

/** A usable group name from the topic model's output, or null for none / adult content / empty. */
export function acceptLabel(raw: string): string | null {
  const label = raw.trim();
  if (REJECTED_LABELS.has(label.toLowerCase())) return null;
  return clipGroupName(label);
}
