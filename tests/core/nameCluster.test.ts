import { describe, expect, it } from 'vitest';
import {
  acceptLabel, clipGroupName, clusterKeywords, embedText, isMostlyLatin, stripSiteSuffix, tokenize, topicPrompt,
} from '../../core/nameCluster';
import { NO_GROUP, type TabInfo } from '../../core/types';

const tab = (url: string, title: string): TabInfo => ({
  id: 1, windowId: 1, url, title, pinned: false, active: false, audible: false,
  lastAccessed: 0, groupId: NO_GROUP, cookieStoreId: 'firefox-default',
});

describe('stripSiteSuffix', () => {
  it('drops the part after the last separator', () => {
    expect(stripSiteSuffix('Pull requests · foo/bar - GitHub')).toBe('Pull requests · foo/bar');
    expect(stripSiteSuffix('News | BBC')).toBe('News');
    expect(stripSiteSuffix('A — B — C')).toBe('A — B');
  });
  it('keeps the title when nothing would be left', () => {
    expect(stripSiteSuffix('- GitHub')).toBe('- GitHub');
    expect(stripSiteSuffix('Plain title')).toBe('Plain title');
  });
});

describe('embedText', () => {
  it('joins the stripped title and the hostname', () => {
    expect(embedText(tab('https://github.com/x', 'Pull requests - GitHub'))).toBe('Pull requests github.com');
  });
  it('embedText falls back to hostname', () => {
    expect(embedText(tab('https://github.com/x', ''))).toBe('github.com');
    expect(embedText(tab('https://github.com/x', 'https://github.com/x'))).toBe('github.com');
  });
});

describe('tokenize', () => {
  it('keeps word-like, lower-cased, non-stopword tokens', () => {
    expect(tokenize('Dogs and Dog Food 2024')).toEqual(['dogs', 'dog', 'food']);
  });
  it('segments Japanese and drops single characters', () => {
    const tokens = tokenize('東京の天気予報');
    expect(tokens).toContain('東京');
    expect(tokens).toContain('天気');
    expect(tokens.every((t) => [...t].length > 1)).toBe(true);
  });
});

describe('clusterKeywords', () => {
  it('prefers terms distinctive for each cluster', () => {
    expect(clusterKeywords([['Dog food', 'Dog toys'], ['Cat food']], 1)).toEqual([['dog'], ['cat']]);
  });
  it('returns no keywords for a cluster of stopwords', () => {
    expect(clusterKeywords([['the and of'], ['Cat food']], 2)[0]).toEqual([]);
  });
});

describe('isMostlyLatin', () => {
  it('needs a strict majority of Latin titles', () => {
    expect(isMostlyLatin(['Dogs', 'Cats'])).toBe(true);
    expect(isMostlyLatin(['犬の餌', '猫'])).toBe(false);
    expect(isMostlyLatin(['Dogs', '犬', '猫'])).toBe(false);
  });
});

describe('topicPrompt', () => {
  it('follows the smart-tab-topic input format with at most 3 titles', () => {
    expect(topicPrompt(['dogs', 'food', 'pets'], ['A', 'B', 'C', 'D']))
      .toBe('Topic from keywords: dogs,food,pets. titles: \nA\nB\nC');
    expect(topicPrompt([], ['A'])).toBe('Topic from keywords: . titles: \nA');
  });
});

describe('acceptLabel', () => {
  it('rejects None, Adult Content and empty output', () => {
    expect(acceptLabel(' None ')).toBeNull();
    expect(acceptLabel('Adult Content')).toBeNull();
    expect(acceptLabel('')).toBeNull();
  });
  it('trims and clips accepted labels', () => {
    expect(acceptLabel(' Dogs ')).toBe('Dogs');
    expect([...acceptLabel('x'.repeat(50))!]).toHaveLength(40);
  });
});

describe('clipGroupName', () => {
  it('cuts to 40 code points without splitting surrogate pairs', () => {
    const name = '😀'.repeat(45);
    expect(clipGroupName(name)).toBe('😀'.repeat(40));
    expect(clipGroupName('  a  ')).toBe('a');
  });
});
