// Asserts the per-browser manifests produced by `npm run build:firefox` and `npm run build:chrome`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIREFOX_DIR = '.output/firefox-mv3';
const CHROME_DIR = '.output/chrome-mv3';

function fail(message) {
  console.error(`check-manifests: FAIL - ${message}`);
  process.exit(1);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function readManifest(dir) {
  const path = join(dir, 'manifest.json');
  check(existsSync(path), `${path} not found (build first)`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

const firefox = readManifest(FIREFOX_DIR);
check(firefox.browser_specific_settings?.gecko?.strict_min_version === '140.0', 'firefox: gecko strict_min_version must be 140.0');
check(!(firefox.permissions ?? []).includes('offscreen'), 'firefox: permissions must not include offscreen');
check(!('minimum_chrome_version' in firefox), 'firefox: must not set minimum_chrome_version');
check(!existsSync(join(FIREFOX_DIR, 'offscreen.html')), 'firefox: offscreen.html must not exist');

const chrome = readManifest(CHROME_DIR);
check(!('browser_specific_settings' in chrome), 'chrome: must not have browser_specific_settings');
check(chrome.minimum_chrome_version === '116', 'chrome: minimum_chrome_version must be 116');
check((chrome.permissions ?? []).includes('offscreen'), 'chrome: permissions must include offscreen');
const iconPaths = [...Object.values(chrome.icons ?? {}), ...Object.values(chrome.action?.default_icon ?? {})];
check(iconPaths.length > 0, 'chrome: no icons declared');
for (const path of iconPaths) {
  check(path.endsWith('.png'), `chrome: icon ${path} must be a .png`);
  check(existsSync(join(CHROME_DIR, path)), `chrome: icon ${path} missing from ${CHROME_DIR}`);
}

console.log('check-manifests: OK');
