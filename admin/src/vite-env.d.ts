/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API base URL; defaults to /api/v1. */
  readonly VITE_API_URL?: string
  /** Telegram bot username (without @) used by the Login Widget. */
  readonly VITE_TELEGRAM_BOT_USERNAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
