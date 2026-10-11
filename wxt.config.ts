import { defineConfig } from 'wxt';

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: 'tab-tidy',
    permissions: ['tabs', 'tabGroups', 'alarms', 'idle', 'storage', 'notifications', 'sessions'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    browser_specific_settings: {
      gecko: { id: 'tab-tidy@sshiraki', strict_min_version: '139.0' },
    },
  },
});
