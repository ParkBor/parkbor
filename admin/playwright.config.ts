import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 4173)
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`
const isCI = Boolean(process.env.CI)
const EXPECT_TIMEOUT_MS = 10_000
const TEST_TIMEOUT_MS = 45_000
const BUILD_TIMEOUT_MS = 240_000

// Admin web E2E. There is no real backend: every /api/v1 call is answered by the typed mock in
// e2e/support/mockApi.ts through page.route(). See admin/e2e/README.md.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: './e2e/.artifacts/test-results',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  reporter: isCI
    ? [
        ['list'],
        ['html', { outputFolder: './e2e/.artifacts/report', open: 'never' }],
        ['junit', { outputFile: './e2e/.artifacts/junit.xml' }],
      ]
    : [['list'], ['html', { outputFolder: './e2e/.artifacts/report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    locale: 'en-US',
    timezoneId: 'Asia/Tashkent',
    viewport: { width: 1366, height: 800 },
    acceptDownloads: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 800 } } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node e2e/support/server.mjs',
        url: BASE_URL,
        reuseExistingServer: !isCI,
        timeout: BUILD_TIMEOUT_MS,
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
