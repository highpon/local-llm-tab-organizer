import { describe, expect, it } from 'vitest';
import { NO_GROUP } from '../core/types';

describe('smoke', () => {
  it('NO_GROUP is -1', () => {
    expect(NO_GROUP).toBe(-1);
  });
});
