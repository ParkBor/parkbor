// Builds the admin SPA into e2e/.artifacts/dist and serves it with `vite preview`.
// The build is separate from admin/dist, so a normal `pnpm build` is never disturbed.
// Env: E2E_PORT (default 4173), E2E_SKIP_BUILD=1 (reuse an earlier build).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const outDir = fileURLToPath(new URL('../.artifacts/dist', import.meta.url))
const buildScript = fileURLToPath(new URL('./build.mjs', import.meta.url))
const port = Number(process.env.E2E_PORT ?? 4173)
const BUILD_ATTEMPTS = 3

function buildOnce() {
  // A child process: the bundler can abort the whole process when the machine is short of memory.
  for (let attempt = 1; attempt <= BUILD_ATTEMPTS; attempt += 1) {
    const result = spawnSync(process.execPath, [buildScript], { stdio: 'inherit', cwd: root })
    if (result.status === 0) return
    console.error(`[e2e] build attempt ${attempt}/${BUILD_ATTEMPTS} failed (exit ${result.status})`)
  }
  process.exit(1)
}

if (process.env.E2E_SKIP_BUILD === '1' && existsSync(outDir)) {
  console.log('[e2e] reusing build in', outDir)
} else {
  buildOnce()
}

const server = await preview({
  root,
  logLevel: 'warn',
  build: { outDir },
  preview: { host: '127.0.0.1', port, strictPort: true },
})
console.log(`[e2e] admin preview ready on http://127.0.0.1:${port}`)

const stop = () => {
  void server.close().finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
