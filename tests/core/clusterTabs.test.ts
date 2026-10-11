import { describe, expect, it } from 'vitest';
import { agglomerate, cosine, joinExisting } from '../../core/clusterTabs';

const unit = (v: number[]): number[] => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
/** Unit vector at `deg` degrees in the x-y plane, so cosine between two is cos(Δdeg). */
const at = (deg: number): number[] => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0];

describe('cosine', () => {
  it('is 1 for identical and 0 for orthogonal vectors', () => {
    expect(cosine(unit([1, 2, 3]), unit([1, 2, 3]))).toBeCloseTo(1);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });
});

describe('joinExisting', () => {
  it('picks the group with the most similar anchor', () => {
    const v = [1, 0, 0];
    const group0 = [unit([0.7, Math.sqrt(1 - 0.49), 0])]; // similarity 0.7
    const group1 = [[0, 0, 1], unit([0.9, Math.sqrt(1 - 0.81), 0])]; // second anchor: 0.9
    expect(joinExisting([v], [group0, group1], 0.5)).toEqual([1]);
  });
  it('requires a similarity strictly above the threshold', () => {
    const anchor = at(60); // cos 60° = 0.5
    expect(joinExisting([at(0)], [[anchor]], cosine(at(0), anchor))).toEqual([-1]);
    expect(joinExisting([at(0)], [[anchor]], 0.49)).toEqual([0]);
  });
  it('joins nothing without groups', () => {
    expect(joinExisting([at(0), at(10)], [], 0.1)).toEqual([-1, -1]);
  });
});

describe('agglomerate', () => {
  it('merges near-identical vectors and leaves an outlier alone', () => {
    const vs = [at(0), at(2), at(4), [0, 0, 1]];
    expect(agglomerate(vs, 0.1)).toEqual([[0, 1, 2], [3]]);
  });
  it('uses average linkage, not single linkage', () => {
    // Pairs {0,1} at 0°/10° and {2,3} at 50°/90°: the closest cross pair (1,2) is 40° apart
    // (distance 0.234), but the average cross distance is ~0.60, above the cutoff.
    const vs = [at(0), at(10), at(50), at(90)];
    expect(agglomerate(vs, 0.3)).toEqual([[0, 1], [2, 3]]);
  });
  it('returns no clusters for no vectors', () => {
    expect(agglomerate([], 0.5)).toEqual([]);
  });
  it('orders clusters by their smallest index', () => {
    const vs = [[0, 0, 1], at(0), at(1)];
    expect(agglomerate(vs, 0.1)).toEqual([[0], [1, 2]]);
  });
});
