import { classifyByDomain, domainKey } from '../core/classifyByDomain';
import {
  agglomerate, ANCHORS_PER_GROUP, CLUSTER_THRESHOLD, joinExisting, JOIN_THRESHOLD, MAX_ON_DEVICE_TABS,
} from '../core/clusterTabs';
import {
  acceptLabel, clipGroupName, clusterKeywords, embedText, isMostlyLatin, stripSiteSuffix, topicPrompt,
} from '../core/nameCluster';
import type { Assignment, ExistingGroup, TabInfo } from '../core/types';
import type { ClassifyResult } from './llmClassifier';
import { createMlClient, type MlClient } from './ml/client';
import { ensureModels, loadModelStatus, noteLoadFailure, noteLoadSuccess, type ModelStatus } from './modelManager';

export interface OnDeviceDeps {
  client: () => MlClient;
  status: () => Promise<ModelStatus>;
  /** Fire-and-forget model download. */
  ensure: () => void;
  loadFailed: () => Promise<void>;
  loadSucceeded: () => Promise<void>;
  timeoutMs: number;
}

const TOPIC_KEYWORDS = 3;
const NAME_KEYWORDS = 2;

function defaultDeps(): OnDeviceDeps {
  return {
    client: () => createMlClient(),
    status: loadModelStatus,
    ensure: () => { void ensureModels(); },
    loadFailed: () => noteLoadFailure(),
    loadSucceeded: noteLoadSuccess,
    timeoutMs: 60_000,
  };
}

class LoadError extends Error {}

const byDomain = (tabs: TabInfo[]): Assignment[] => classifyByDomain(tabs);

/** Name of the most common domain among the tabs, as classifyByDomain would name it. */
function domainName(tabs: TabInfo[]): string | null {
  const counts = new Map<string, { n: number; tab: TabInfo }>();
  for (const tab of tabs) {
    const key = domainKey(tab.url);
    if (!key) continue;
    const c = counts.get(key);
    counts.set(key, { n: (c?.n ?? 0) + 1, tab: c?.tab ?? tab });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best ? (byDomain([best.tab])[0]?.group ?? null) : null;
}

async function classifyWithModels(
  client: MlClient, tabs: TabInfo[], existing: ExistingGroup[], loadSucceeded: () => Promise<void>,
): Promise<Assignment[]> {
  try {
    // Cached models only: downloading belongs to the model manager, outside the run lock.
    await client.load(undefined, false);
  } catch (e) {
    throw new LoadError(e instanceof Error ? e.message : String(e));
  }
  await loadSucceeded().catch(() => {});
  const groups = existing.filter((g) => g.title.trim() !== '');
  const anchorTexts = groups.map((g) => [g.title, ...g.tabs.slice(0, ANCHORS_PER_GROUP).map(embedText)]);
  const vectors = await client.embed([...tabs.map(embedText), ...anchorTexts.flat()]);
  const tabVectors = vectors.slice(0, tabs.length);
  let offset = tabs.length;
  const anchorVectors = anchorTexts.map((texts) => {
    const vs = vectors.slice(offset, offset + texts.length);
    offset += texts.length;
    return vs;
  });

  const out: Assignment[] = [];
  const joined = joinExisting(tabVectors, anchorVectors, JOIN_THRESHOLD);
  const rest: number[] = [];
  joined.forEach((g, i) => {
    if (g >= 0) out.push({ tabId: tabs[i]!.id, group: groups[g]!.title });
    else rest.push(i);
  });

  const clusters = agglomerate(rest.map((i) => tabVectors[i]!), CLUSTER_THRESHOLD).map((c) => c.map((k) => tabs[rest[k]!]!));
  const singles = clusters.filter((c) => c.length === 1).flat();
  const multi = clusters.filter((c) => c.length > 1);
  out.push(...byDomain(singles));

  const titles = multi.map((c) => c.map((t) => stripSiteSuffix(t.title)));
  const keywords = clusterKeywords(titles, TOPIC_KEYWORDS);
  const latin = multi.flatMap((_, k) => (isMostlyLatin(titles[k]!) ? [k] : []));
  const labels = new Map<number, string>();
  if (latin.length > 0) {
    const generated = await client.topic(latin.map((k) => topicPrompt(keywords[k]!, titles[k]!)));
    latin.forEach((k, j) => {
      const label = acceptLabel(generated[j] ?? '');
      if (label) labels.set(k, label);
    });
  }
  multi.forEach((cluster, k) => {
    const fromKeywords = clipGroupName(keywords[k]!.slice(0, NAME_KEYWORDS).join(' '));
    const name = labels.get(k) ?? (fromKeywords || domainName(cluster));
    if (name) out.push(...cluster.map((t) => ({ tabId: t.id, group: name })));
    else out.push(...byDomain(cluster));
  });
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`On-device classification timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Rule: if the models are not ready, start the download and classify by domain (modelNotReady, or
 * modelDownloadFailed after a failed download).
 * Otherwise up to 300 tabs are embedded: a tab joins the existing group with the most similar
 * anchor (group title + its first 3 tabs) above JOIN_THRESHOLD; the rest are clustered, and
 * singleton clusters are classified by domain. A cluster is named by the topic model when its
 * titles are mostly Latin, else by its top keywords, else by its most common domain. Tabs over
 * the cap are classified by domain (method 'mixed'). Any failure or a 60 s timeout classifies
 * everything by domain (inferenceFailed); a failure to load ready models is reported to the model
 * manager, which deletes them if the cache is gone or the failures repeat.
 */
export async function classifyOnDevice(
  tabs: TabInfo[], existing: ExistingGroup[], deps: Partial<OnDeviceDeps> = {},
): Promise<ClassifyResult> {
  const d = { ...defaultDeps(), ...deps };
  if (tabs.length === 0) return { assignments: [], method: 'onDevice' };
  const { state } = await d.status();
  if (state !== 'ready') {
    d.ensure();
    return { assignments: byDomain(tabs), method: 'domain', error: state === 'error' ? 'modelDownloadFailed' : 'modelNotReady' };
  }
  const head = tabs.slice(0, MAX_ON_DEVICE_TABS);
  const tail = tabs.slice(MAX_ON_DEVICE_TABS);
  const client = d.client();
  try {
    const assignments = await withTimeout(classifyWithModels(client, head, existing, d.loadSucceeded), d.timeoutMs);
    return {
      assignments: [...assignments, ...byDomain(tail)],
      method: tail.length > 0 ? 'mixed' : 'onDevice',
    };
  } catch (e) {
    if (e instanceof LoadError) await d.loadFailed().catch(() => {});
    return { assignments: byDomain(tabs), method: 'domain', error: 'inferenceFailed' };
  } finally {
    client.terminate();
  }
}
