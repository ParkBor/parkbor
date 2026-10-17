// Publishes an OTA update to the production channel with the production marker set.
// APP_ENV=production makes app.config.ts demand the real production env values and refuse
// EXPO_PUBLIC_PAYMENT_SANDBOX=true; without the marker `eas update` would resolve the config like a
// development build. Usage: pnpm --filter mobile update:production -- --message "..."
const { spawnSync } = require('node:child_process');

const extraArgs = process.argv.slice(2).filter((arg) => arg !== '--');
const result = spawnSync('npx', ['eas-cli', 'update', '--channel', 'production', ...extraArgs], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, APP_ENV: 'production' },
});

process.exit(result.status ?? 1);
