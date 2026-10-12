import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'wxt';

// The ONNX Runtime build Transformers.js loads in browsers (see env.backends.onnx.wasm in ml.worker.ts).
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

/** onnxruntime-web is resolved from Transformers.js so the copied files match the version it imports. */
function ortDistDir(): string {
  const transformers = createRequire(import.meta.url).resolve('@huggingface/transformers');
  // Resolves to a file inside onnxruntime-web/dist.
  return dirname(createRequire(transformers).resolve('onnxruntime-web'));
}

export default defineConfig({
  manifestVersion: 3,
  vite: () => ({
    // Picks the onnxruntime-web build that loads the WASM from wasmPaths instead of inlining it
    // (the default "bundle" build embeds two WASM binaries as base64, ~70 MB).
    resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'] },
  }),
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      const dir = ortDistDir();
      for (const name of ORT_FILES) files.push({ absoluteSrc: join(dir, name), relativeDest: `ort/${name}` });
    },
  },
  manifest: ({ browser }) => {
    const isChrome = browser === 'chrome';
    const pngIcons = { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' };
    const svgIcons = { 48: 'icon.svg', 96: 'icon.svg' };
    const icons = isChrome ? pngIcons : svgIcons;
    return {
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
      },
      name: '__MSG_extName__',
      description: '__MSG_extDescription__',
      default_locale: 'en',
      permissions: ['tabs', 'tabGroups', 'alarms', 'idle', 'storage', 'notifications', 'sessions', ...(isChrome ? ['offscreen'] : [])],
      optional_host_permissions: ['http://*/*', 'https://*/*'],
      icons,
      action: { default_icon: icons },
      ...(isChrome
        ? { minimum_chrome_version: '116' }
        : {
            browser_specific_settings: {
              gecko: {
                id: 'local-llm-tab-organizer@sshiraki',
                strict_min_version: '140.0',
                // Only tab titles/URLs go to the LLM server the user configured; nothing is sent to us.
                data_collection_permissions: { required: ['none'] },
              },
            },
          }),
    };
  },
});
