import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const SLOW_TEST_TIMEOUT_MS = 15_000
const MAX_TEST_WORKERS = 2

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8000' } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Ant Design forms are heavy under jsdom; keep the load on small machines bounded.
    testTimeout: SLOW_TEST_TIMEOUT_MS,
    hookTimeout: SLOW_TEST_TIMEOUT_MS,
    maxWorkers: MAX_TEST_WORKERS,
  },
})
