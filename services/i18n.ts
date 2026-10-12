import en from '../public/_locales/en/messages.json';

type MessageEntry = { message: string; placeholders?: Record<string, { content: string }> };
const fallback = en as Record<string, MessageEntry>;

/** Resolves a message from the bundled English catalog, mirroring browser.i18n placeholder rules. */
function fromFallback(key: string, subs: string[]): string {
  const entry = fallback[key];
  if (!entry) return key;
  const positional = (s: string) => s.replace(/\$(\d)/g, (_, n: string) => subs[Number(n) - 1] ?? '');
  return entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, name: string) => {
    const p = entry.placeholders?.[name.toLowerCase()];
    return p ? positional(p.content) : whole;
  });
}

/** Returns the origin pattern for this browser's extension protocol, e.g. 'chrome-extension://*' */
export function extensionOriginPattern(): string {
  const url = browser.runtime.getURL('/');
  const protocol = new URL(url).protocol;
  return `${protocol}//*`;
}

/** Localized message for `key`. Falls back to English where browser.i18n is unavailable (e.g. tests). */
export function t(key: string, ...subs: (string | number)[]): string {
  const s = subs.map(String);
  try {
    // Keys are checked against messages.json by tests, so the loose signature is safe here.
    const i18n = browser.i18n as unknown as { getMessage?: (k: string, subs?: string[]) => string } | undefined;
    const msg = i18n?.getMessage?.(key, s);
    if (msg) return msg;
  } catch {
    // fall through
  }
  return fromFallback(key, s);
}

export function uiLanguage(): string {
  try {
    return browser.i18n?.getUILanguage?.() || 'en';
  } catch {
    return 'en';
  }
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(uiLanguage());
}

/** Fills every element carrying `data-i18n="key"` with its message and sets the document language. */
export function localizeDocument(doc: Document = document): void {
  doc.documentElement.lang = uiLanguage();
  for (const el of doc.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n!);
  }
}
