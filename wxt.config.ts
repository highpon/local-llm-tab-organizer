import { defineConfig } from 'wxt';

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: ['tabs', 'tabGroups', 'alarms', 'idle', 'storage', 'notifications', 'sessions'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    icons: { 48: 'icon.svg', 96: 'icon.svg' },
    action: { default_icon: { 48: 'icon.svg', 96: 'icon.svg' } },
    browser_specific_settings: {
      gecko: {
        id: 'tab-tidy@sshiraki',
        strict_min_version: '140.0',
        // Only tab titles/URLs go to the LLM server the user configured; nothing is sent to us.
        data_collection_permissions: { required: ['none'] },
      },
    },
  },
});
