import { describe, it, expect } from 'vitest';
import { domainKey, classifyByDomain } from '../../core/classifyByDomain';
import type { TabInfo } from '../../core/types';

const tab = (id: number, url: string): TabInfo => ({
  id, windowId: 1, url, title: '', pinned: false, active: false,
  audible: false, lastAccessed: 0, groupId: -1, cookieStoreId: 'firefox-default',
});

describe('domainKey', () => {
  it('collapses subdomains to the registrable domain', () => {
    expect(domainKey('https://docs.github.com/x')).toBe('github.com');
    expect(domainKey('https://www.github.com')).toBe('github.com');
  });
  it('handles multi-part public suffixes', () => {
    expect(domainKey('https://news.bbc.co.uk/a')).toBe('bbc.co.uk');
  });
  it('falls back to the hostname for localhost and IPs', () => {
    expect(domainKey('http://localhost:3000/')).toBe('localhost');
    expect(domainKey('http://192.168.1.10/')).toBe('192.168.1.10');
  });
  it('returns null instead of throwing for unparseable input', () => {
    expect(domainKey('')).toBeNull();
    expect(domainKey('not a url')).toBeNull();
    expect(domainKey('about:blank')).toBeNull();
  });
});

describe('classifyByDomain', () => {
  it('gives tabs of the same domain the same display name', () => {
    const r = classifyByDomain([
      tab(1, 'https://docs.github.com/x'),
      tab(2, 'https://github.com/o/r'),
      tab(3, 'https://news.bbc.co.uk/a'),
      tab(4, 'http://localhost:3000/'),
    ]);
    expect(r).toEqual([
      { tabId: 1, group: 'Github' },
      { tabId: 2, group: 'Github' },
      { tabId: 3, group: 'Bbc' },
      { tabId: 4, group: 'localhost' },
    ]);
  });
  it('skips tabs whose domain cannot be determined', () => {
    expect(classifyByDomain([tab(1, 'about:blank')])).toEqual([]);
  });
});
