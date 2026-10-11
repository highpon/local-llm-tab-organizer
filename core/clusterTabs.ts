export const MAX_ON_DEVICE_TABS = 300;
export const ANCHORS_PER_GROUP = 3;
/** Minimum cosine similarity to an existing group's anchor for a tab to join it. */
export const JOIN_THRESHOLD = 0.5; // chosen from tests/fixtures/embeddings.json (see tests/core/thresholds.test.ts)
/** Maximum average cosine distance between two clusters for them to merge. */
export const CLUSTER_THRESHOLD = 0.4; // chosen from tests/fixtures/embeddings.json (see tests/core/thresholds.test.ts)

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Per vector: index of the group whose best anchor similarity is highest and above threshold, else -1. */
export function joinExisting(vectors: number[][], groupAnchors: number[][][], threshold: number): number[] {
  return vectors.map((v) => {
    let best = -1;
    let bestScore = threshold;
    groupAnchors.forEach((anchors, g) => {
      for (const a of anchors) {
        const s = cosine(v, a);
        if (s > bestScore) {
          bestScore = s;
          best = g;
        }
      }
    });
    return best;
  });
}

/** Average-linkage agglomerative clustering; clusters are index lists ordered by their smallest index. */
export function agglomerate(vectors: number[][], maxDistance: number): number[][] {
  const n = vectors.length;
  const dist: number[][] = vectors.map((a) => vectors.map((b) => 1 - cosine(a, b)));
  let clusters: number[][] = vectors.map((_, i) => [i]);
  const avg = (x: number[], y: number[]): number => {
    let sum = 0;
    for (const i of x) for (const j of y) sum += dist[i]![j]!;
    return sum / (x.length * y.length);
  };
  while (clusters.length > 1 && n > 1) {
    let bi = -1;
    let bj = -1;
    let bd = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = avg(clusters[i]!, clusters[j]!);
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    }
    if (bd > maxDistance) break;
    const merged = [...clusters[bi]!, ...clusters[bj]!].sort((a, b) => a - b);
    clusters = clusters.filter((_, k) => k !== bi && k !== bj);
    clusters.push(merged);
  }
  return clusters.sort((a, b) => a[0]! - b[0]!);
}
