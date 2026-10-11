import { describe, it, expect } from 'vitest';
import { normalizeUrl } from '../../core/normalizeUrl';

const same = (a: string, b: string) => expect(normalizeUrl(a)).toBe(normalizeUrl(b));
const diff = (a: string, b: string) => expect(normalizeUrl(a)).not.toBe(normalizeUrl(b));

describe('normalizeUrl', () => {
  it('treats tracking/fragment/slash/scheme/www variants as same', () => {
    same('https://example.com/a?utm_source=x#top', 'http://www.example.com/a/');
    same('https://example.com/?fbclid=1&gclid=2&mc_cid=3&mc_eid=4&ref_src=5', 'https://example.com');
    same('https://EXAMPLE.com/a?b=2&a=1', 'https://example.com/a?a=1&b=2');
  });
  it('drops tracking keys regardless of case', () => {
    same('https://example.com/a?UTM_Source=x&FBCLID=1&GClid=2&Mc_Cid=3&MC_EID=4&Ref_Src=5', 'https://example.com/a');
    same('https://example.com/a?Utm_medium=x&id=7', 'https://example.com/a?id=7');
  });
  it('keeps meaningful query', () => {
    diff('https://www.youtube.com/watch?v=aaa', 'https://www.youtube.com/watch?v=bbb');
    diff('https://www.google.com/search?q=rust', 'https://www.google.com/search?q=go');
    diff('https://github.com/o/r?ref=main', 'https://github.com/o/r?ref=dev');
  });
  it('returns null for non-http', () => {
    expect(normalizeUrl('about:newtab')).toBeNull();
    expect(normalizeUrl('moz-extension://x/popup.html')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});
