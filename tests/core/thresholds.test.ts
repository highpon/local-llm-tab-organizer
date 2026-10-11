// Guards CLUSTER_THRESHOLD and JOIN_THRESHOLD against real embeddings of English and Japanese tab
// texts (regenerate with `node scripts/embed-fixture.mjs > tests/fixtures/embeddings.json`).
// The thresholds favour precision: a tab left ungrouped falls back to domain grouping, while a tab
// put into the wrong group is a visible mistake.
import { describe, expect, it } from 'vitest';
import { agglomerate, CLUSTER_THRESHOLD, joinExisting, JOIN_THRESHOLD } from '../../core/clusterTabs';
import fixture from '../fixtures/embeddings.json';

const items = fixture.items;
const vectors = items.map((i) => i.vector);
const MAIN = ['review', 'cooking', 'trains', 'typescript', 'travel'];
const indicesOf = (topic: string) => items.flatMap((x, i) => (x.topic === topic ? [i] : []));
const isJapanese = (text: string) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
// Train timetables and travel booking for Japan overlap in meaning; merging them is tolerated.
const RELATED = new Set(['trains+travel']);

describe('CLUSTER_THRESHOLD', () => {
  const clusters = agglomerate(vectors, CLUSTER_THRESHOLD);
  const topicsOf = (c: number[]) => [...new Set(c.map((i) => items[i]!.topic))].sort();

  it('keeps clusters pure', () => {
    let pure = 0;
    for (const c of clusters) {
      const counts = new Map<string, number>();
      for (const i of c) counts.set(items[i]!.topic, (counts.get(items[i]!.topic) ?? 0) + 1);
      pure += Math.max(...counts.values());
    }
    expect(pure / items.length).toBeGreaterThanOrEqual(0.9);
  });

  it('never mixes unrelated main topics', () => {
    for (const c of clusters) {
      const main = topicsOf(c).filter((t) => MAIN.includes(t));
      if (main.length > 1) expect(RELATED.has(main.join('+'))).toBe(true);
    }
  });

  it('forms a group of 2+ tabs for every main topic', () => {
    for (const topic of MAIN) {
      const own = clusters.filter((c) => c.length >= 2 && c.filter((i) => items[i]!.topic === topic).length >= 2);
      expect(own.length, topic).toBeGreaterThan(0);
    }
  });

  it('puts English and Japanese tabs of a topic together somewhere', () => {
    const together = MAIN.filter((topic) => clusters.some((c) => {
      const own = c.filter((i) => items[i]!.topic === topic);
      return own.some((i) => isJapanese(items[i]!.text)) && own.some((i) => !isJapanese(items[i]!.text));
    }));
    expect(together.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves unrelated English tabs alone', () => {
    for (const topic of ['single-bank', 'single-music']) {
      const [i] = indicesOf(topic);
      expect(clusters.find((c) => c.includes(i!))).toHaveLength(1);
    }
  });
});

describe('JOIN_THRESHOLD', () => {
  const anchorIdx = MAIN.map((t) => indicesOf(t).slice(0, 3));
  const joined = joinExisting(vectors, anchorIdx.map((ids) => ids.map((i) => vectors[i]!)), JOIN_THRESHOLD);
  const anchors = new Set(anchorIdx.flat());
  const others = items.flatMap((x, i) => (anchors.has(i) ? [] : [{ ...x, i }]));

  it('joins most tabs to their own topic', () => {
    const main = others.filter((x) => MAIN.includes(x.topic));
    const right = main.filter((x) => joined[x.i] === MAIN.indexOf(x.topic)).length;
    expect(right / main.length).toBeGreaterThanOrEqual(0.7);
  });

  it('rarely joins a wrong group', () => {
    const wrong = others.filter((x) => joined[x.i] !== -1 && joined[x.i] !== MAIN.indexOf(x.topic));
    expect(wrong.length).toBeLessThanOrEqual(2);
  });

  it('joins nothing for unrelated English tabs', () => {
    for (const topic of ['single-bank', 'single-music']) expect(joined[indicesOf(topic)[0]!]).toBe(-1);
  });
});
