import type { TelegramWidgetPayload } from '@habi/api-client'
import { Alert, Button, Card, Spin, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router-dom'
import { LanguageSelect } from '../components/LanguageSelect'
import { useAuth } from '../lib/auth'
import { type AuthErrorKey, loginErrorKey, safeRedirectTarget } from '../lib/authErrors'
import {
  FULL_HEIGHT_CENTER,
  LOGIN_CARD_WIDTH_PX,
  PAGE_PADDING_PX,
  WIDGET_MIN_HEIGHT_PX,
} from '../lib/styles'

const WIDGET_SRC = 'https://telegram.org/js/telegram-widget.js'
/**
 * Global the widget calls: data-onauth is evaluated in the page scope as "name(user)".
 * (telegram-widget.js does this with eval(), so the production CSP needs 'unsafe-eval' on this
 * page; see docs/ARCHITECTURE.md, "Admin veb xavfsizligi".)
 */
const CALLBACK_NAME = 'habiTelegramAuth'
// Telegram bot usernames: 5-32 chars, letters/digits/underscore, starting with a letter.
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/

type WidgetState = 'loading' | 'ready' | 'failed'

function normalizeBotUsername(raw: string | undefined): string | null {
  const name = (raw ?? '').trim().replace(/^@/, '')
  return BOT_USERNAME.test(name) ? name : null
}

function isWidgetPayload(value: unknown): value is TelegramWidgetPayload {
  if (typeof value !== 'object' || value === null) return false
  const user = value as Record<string, unknown>
  return (
    typeof user.id === 'number' && typeof user.auth_date === 'number' && typeof user.hash === 'string'
  )
}

interface LoginPageProps {
  /** Overridable for tests; defaults to VITE_TELEGRAM_BOT_USERNAME. */
  botUsername?: string
}

export default function LoginPage({ botUsername = import.meta.env.VITE_TELEGRAM_BOT_USERNAME }: LoginPageProps) {
  const { t } = useTranslation()
  const { status, login } = useAuth()
  const location = useLocation()
  const containerRef = useRef<HTMLDivElement>(null)
  const isSubmittingRef = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorKey, setErrorKey] = useState<AuthErrorKey | null>(null)
  const [widgetState, setWidgetState] = useState<WidgetState>('loading')
  const [attempt, setAttempt] = useState(0)
  const bot = normalizeBotUsername(botUsername)

  // The widget callback always sees the latest login without re-adding the script.
  const handleAuthRef = useRef<(user: unknown) => Promise<void>>(async () => undefined)
  useEffect(() => {
    handleAuthRef.current = async (user) => {
      if (isSubmittingRef.current) return
      setErrorKey(null)
      if (!isWidgetPayload(user)) {
        setErrorKey('auth.errors.invalidWidget')
        return
      }
      isSubmittingRef.current = true
      setIsSubmitting(true)
      try {
        await login(user) // exactly what Telegram returned: the HMAC covers every field
      } catch (error) {
        setErrorKey(loginErrorKey(error))
      } finally {
        isSubmittingRef.current = false
        setIsSubmitting(false)
      }
    }
  })

  useEffect(() => {
    const container = containerRef.current
    if (!bot || !container) return
    const callback = (user: unknown) => handleAuthRef.current(user)
    const globals = window as unknown as Record<string, unknown>
    globals[CALLBACK_NAME] = callback

    const script = document.createElement('script')
    script.async = true
    script.src = WIDGET_SRC
    script.setAttribute('data-telegram-login', bot)
    script.setAttribute('data-size', 'large')
    script.setAttribute('data-userpic', 'false')
    script.setAttribute('data-onauth', `${CALLBACK_NAME}(user)`)
    const onLoad = () => setWidgetState('ready')
    const onError = () => setWidgetState('failed')
    script.addEventListener('load', onLoad)
    script.addEventListener('error', onError)
    container.replaceChildren(script)

    return () => {
      script.removeEventListener('load', onLoad)
      script.removeEventListener('error', onError)
      container.replaceChildren() // script and the iframe it created
      if (globals[CALLBACK_NAME] === callback) delete globals[CALLBACK_NAME]
    }
  }, [bot, attempt])

  if (status === 'authenticated') {
    const from = (location.state as { from?: unknown } | null)?.from
    return <Navigate to={safeRedirectTarget(from)} replace />
  }

  const shownErrorKey: AuthErrorKey | null = !bot
    ? 'auth.errors.botNotConfigured'
    : widgetState === 'failed'
      ? 'auth.errors.widgetLoad'
      : errorKey

  return (
    <div style={{ ...FULL_HEIGHT_CENTER, padding: PAGE_PADDING_PX }}>
      <Card style={{ width: LOGIN_CARD_WIDTH_PX, textAlign: 'center' }}>
        <div style={{ textAlign: 'right' }}>
          <LanguageSelect />
        </div>
        <Typography.Title level={3}>{t('app.title')}</Typography.Title>
        <Typography.Paragraph type="secondary">{t('auth.subtitle')}</Typography.Paragraph>
        {shownErrorKey && (
          <Alert
            type="error"
            showIcon
            message={t(shownErrorKey)}
            style={{ marginBottom: PAGE_PADDING_PX }}
            action={
              widgetState === 'failed' && bot ? (
                <Button
                  size="small"
                  onClick={() => {
                    setWidgetState('loading')
                    setAttempt((n) => n + 1)
                  }}
                >
                  {t('common.retry')}
                </Button>
              ) : undefined
            }
          />
        )}
        {isSubmitting && (
          <div role="status">
            <Spin /> <Typography.Text>{t('auth.signingIn')}</Typography.Text>
          </div>
        )}
        <div
          ref={containerRef}
          data-testid="widget-area"
          aria-busy={bot !== null && widgetState === 'loading'}
          style={{ display: isSubmitting ? 'none' : 'block', minHeight: WIDGET_MIN_HEIGHT_PX }}
        />
      </Card>
    </div>
  )
}
