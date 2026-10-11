import { getDomain, getDomainWithoutSuffix, getHostname } from 'tldts';
import type { Assignment, TabInfo } from './types';

/** Registrable domain (e.g. github.com); hostname for localhost/IPs; null if unparseable. Never throws. */
export function domainKey(url: string): string | null {
  try {
    return getDomain(url) ?? getHostname(url) ?? null;
  } catch {
    return null;
  }
}

/** Display name derived from the domain key so every tab of a domain gets the same name. */
function displayName(key: string): string {
  const name = getDomain(key) === key ? getDomainWithoutSuffix(key) : null;
  if (!name) return key;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function classifyByDomain(tabs: TabInfo[]): Assignment[] {
  const result: Assignment[] = [];
  for (const tab of tabs) {
    const key = domainKey(tab.url);
    if (key) result.push({ tabId: tab.id, group: displayName(key) });
  }
  return result;
}
