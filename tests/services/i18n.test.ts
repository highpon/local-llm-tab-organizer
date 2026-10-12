import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { t } from '../../services/i18n';

type Catalog = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;

const root = join(__dirname, '../..');
const load = (lang: string): Catalog =>
  JSON.parse(readFileSync(join(root, 'public/_locales', lang, 'messages.json'), 'utf8'));
const en = load('en');
const ja = load('ja');

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) return sourceFiles(rel);
    return /\.(ts|html)$/.test(name) ? [rel] : [];
  });
}

function referencedKeys(): Set<string> {
  const keys = new Set<string>();
  // services/i18n.ts is the helper itself; its doc comments mention example keys.
  const files = [...sourceFiles('entrypoints'), ...sourceFiles('services'), 'wxt.config.ts']
    .filter((f) => !f.endsWith('i18n.ts'));
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const re of [/\bt\('(\w+)'/g, /data-i18n="(\w+)"/g, /__MSG_(\w+)__/g]) {
      for (const m of text.matchAll(re)) keys.add(m[1]!);
    }
  }
  return keys;
}

describe('locales', () => {
  it('en and ja define the same keys', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
  });

  it('en and ja use the same placeholders', () => {
    for (const key of Object.keys(en)) {
      expect(ja[key]?.placeholders, key).toEqual(en[key]!.placeholders);
      const names = (msg: string) => [...msg.matchAll(/\$(\w+)\$/g)].map((m) => m[1]!.toLowerCase()).sort();
      expect(names(ja[key]!.message), key).toEqual(names(en[key]!.message));
      expect(names(en[key]!.message), key).toEqual(Object.keys(en[key]!.placeholders ?? {}).sort());
    }
  });

  it('every key referenced in code exists', () => {
    const keys = referencedKeys();
    expect(keys.size).toBeGreaterThan(50);
    expect([...keys].filter((k) => !(k in en))).toEqual([]);
  });

  it('every defined key is referenced', () => {
    const keys = referencedKeys();
    expect(Object.keys(en).filter((k) => !keys.has(k))).toEqual([]);
  });
});

describe('t', () => {
  it('substitutes placeholders from the fallback catalog', () => {
    expect(t('runSummary', 'now', 3, 2)).toBe('now: closed 3 / grouped 2');
    expect(t('connected', 5)).toBe('Connected (5 models)');
  });

  it('returns the key for an unknown message', () => {
    expect(t('noSuchKey')).toBe('noSuchKey');
  });
});

describe('extensionOriginPattern', () => {
  it('extensionOriginPattern follows the running browser', async () => {
    const { extensionOriginPattern } = await import('../../services/i18n');
    expect(extensionOriginPattern()).toBe('chrome-extension://*'); // fakeBrowser serves chrome-extension:// URLs
  });

  it.each(['ollamaGuide', 'notifyForbidden'])('%s includes the origin', async (key) => {
    const { extensionOriginPattern } = await import('../../services/i18n');
    const origin = extensionOriginPattern();
    expect(t(key, origin)).toContain(`OLLAMA_ORIGINS=${origin}`);
    expect(en[key as keyof typeof en]!.message).not.toContain('moz-extension');
    expect(ja[key as keyof typeof ja]!.message).not.toContain('moz-extension');
  });
});
