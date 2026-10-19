// One production build of the admin SPA for the E2E run (spawned by server.mjs).
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const outDir = fileURLToPath(new URL('../.artifacts/dist', import.meta.url))
// The login page renders the widget only for a valid bot name (the Telegram script itself is
// replaced by a stub inside the tests).
process.env.VITE_TELEGRAM_BOT_USERNAME = 'ParkBorE2EBot'
// Requests go to the default /api/v1 on the preview origin and are answered by page.route().
delete process.env.VITE_API_URL
await build({ root, logLevel: 'warn', build: { outDir, emptyOutDir: true } })
