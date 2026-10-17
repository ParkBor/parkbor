import { ApiError, type TelegramWidgetPayload } from '@habi/api-client'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthState, SessionSupersededError } from '../lib/auth'
import { anonymousAuth, makeAuth } from '../test/authFixtures'
import LoginPage from './LoginPage'

const SCRIPT_SELECTOR = 'script[src="https://telegram.org/js/telegram-widget.js"]'

const widgetUser: TelegramWidgetPayload = {
  id: 7,
  auth_date: 1700000000,
  hash: 'b'.repeat(64),
  first_name: 'Ali',
  username: 'ali',
  future_field: 'kept',
}

interface PageOptions {
  /** Omit to render <LoginPage /> with no prop at all (the env default, unset in tests). */
  bot?: string
  strict?: boolean
  from?: string
}

function renderPage(auth: AuthState, options: PageOptions = {}) {
  const page = 'bot' in options ? <LoginPage botUsername={options.bot} /> : <LoginPage />
  const tree = (
    <AuthContext.Provider value={auth}>
      <MemoryRouter
        initialEntries={[{ pathname: '/login', state: options.from ? { from: { pathname: options.from } } : null }]}
      >
        <Routes>
          <Route path="/login" element={page} />
          <Route path="/parkings" element={<p>parkings page</p>} />
          <Route path="/tariffs" element={<p>tariffs page</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  )
  return render(options.strict ? <StrictMode>{tree}</StrictMode> : tree)
}

const BOT = { bot: 'HabiParkingBot' }

function widgetScript(): HTMLScriptElement | null {
  return document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR)
}

/** The widget evaluates data-onauth="name(user)" against the global scope. */
function callbackName(): string {
  return (widgetScript()?.getAttribute('data-onauth') ?? '').replace(/\(user\)$/, '')
}

function widgetCallback(): (user: unknown) => Promise<void> {
  return (window as unknown as Record<string, unknown>)[callbackName()] as (user: unknown) => Promise<void>
}

function fireWidgetCallback(value: unknown): Promise<void> {
  const callback = widgetCallback()
  return act(async () => {
    await callback(value)
  })
}

/** Fire without waiting for the sign-in to finish (act would otherwise hold back rendering). */
function startWidgetCallback(value: unknown): Promise<void> {
  const callback = widgetCallback()
  let pending: Promise<void> = Promise.resolve()
  act(() => {
    pending = callback(value)
  })
  return pending
}

afterEach(() => {
  document.querySelectorAll(SCRIPT_SELECTOR).forEach((el) => el.remove())
})

describe('Telegram widget script', () => {
  it('adds the official script with the bot username and a callback', () => {
    renderPage(anonymousAuth(), BOT)
    const script = widgetScript()
    expect(script).not.toBeNull()
    expect(script?.getAttribute('data-telegram-login')).toBe('HabiParkingBot')
    expect(script?.getAttribute('data-onauth')).toMatch(/^[A-Za-z_$][\w$]*\(user\)$/)
    expect(script?.async).toBe(true)
  })

  it('does not duplicate the script under StrictMode double effects', () => {
    renderPage(anonymousAuth(), { ...BOT, strict: true })
    expect(document.querySelectorAll(SCRIPT_SELECTOR)).toHaveLength(1)
  })

  it('removes the script and the global callback on unmount', () => {
    const { unmount } = renderPage(anonymousAuth(), BOT)
    const name = callbackName()
    expect(typeof (window as unknown as Record<string, unknown>)[name]).toBe('function')
    unmount()
    expect(widgetScript()).toBeNull()
    expect((window as unknown as Record<string, unknown>)[name]).toBeUndefined()
  })

  it.each(['', '   ', 'bad name', 'x', 'a"onload="alert(1)'])(
    'shows a configuration error and loads nothing for the bot username %j',
    (bot) => {
      renderPage(anonymousAuth(), { bot })
      expect(screen.getByRole('alert')).toHaveTextContent('Telegram bot sozlanmagan')
      expect(widgetScript()).toBeNull()
    },
  )

  it('shows the configuration error when VITE_TELEGRAM_BOT_USERNAME is not set at all', () => {
    renderPage(anonymousAuth())
    expect(screen.getByRole('alert')).toHaveTextContent('Telegram bot sozlanmagan')
    expect(widgetScript()).toBeNull()
  })

  it('accepts a leading @ in the configured username', () => {
    renderPage(anonymousAuth(), { bot: '@HabiParkingBot' })
    expect(widgetScript()?.getAttribute('data-telegram-login')).toBe('HabiParkingBot')
  })

  it('marks the widget area busy until the script has loaded', async () => {
    renderPage(anonymousAuth(), BOT)
    const area = screen.getByTestId('widget-area')
    expect(area).toHaveAttribute('aria-busy', 'true')
    await act(async () => {
      widgetScript()?.dispatchEvent(new Event('load'))
    })
    expect(area).toHaveAttribute('aria-busy', 'false')
  })

  it('shows a load error with a retry button that adds a fresh script', async () => {
    renderPage(anonymousAuth(), BOT)
    await act(async () => {
      widgetScript()?.dispatchEvent(new Event('error'))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('vidjetini yuklab bo‘lmadi')
    await userEvent.click(screen.getByRole('button', { name: 'Qayta urinish' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelectorAll(SCRIPT_SELECTOR)).toHaveLength(1)
    expect(screen.getByTestId('widget-area')).toHaveAttribute('aria-busy', 'true')
  })
})

describe('widget callback', () => {
  it('passes the object returned by the widget to login unchanged (same reference)', async () => {
    const auth = anonymousAuth()
    renderPage(auth, BOT)
    await fireWidgetCallback(widgetUser)
    expect(auth.login).toHaveBeenCalledTimes(1)
    expect(vi.mocked(auth.login).mock.calls[0][0]).toBe(widgetUser)
    expect(widgetUser).toEqual({
      id: 7,
      auth_date: 1700000000,
      hash: 'b'.repeat(64),
      first_name: 'Ali',
      username: 'ali',
      future_field: 'kept',
    })
  })

  it.each([undefined, false, null, 'str', {}])('does not call the API for the bad callback value %j', async (value) => {
    const auth = anonymousAuth()
    renderPage(auth, BOT)
    await fireWidgetCallback(value)
    expect(auth.login).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('yaroqsiz yoki eskirgan')
  })

  it('ignores a second callback while the first sign-in is still running', async () => {
    let finish: () => void = () => undefined
    const login = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    renderPage(anonymousAuth({ login }), BOT)
    const first = startWidgetCallback(widgetUser)
    await waitFor(() => expect(screen.getByText('Kirilmoqda…')).toBeInTheDocument())
    await fireWidgetCallback(widgetUser)
    expect(login).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish()
      await first
    })
  })

  it.each([
    [400, { detail: 'Invalid', code: 'invalid_widget' }, 'yaroqsiz yoki eskirgan'],
    [403, { detail: 'No', code: 'role_not_allowed' }, 'ruxsat etilmagan'],
    [403, { detail: 'Off', code: 'account_disabled' }, 'Hisob o‘chirilgan'],
    [429, { detail: 'Slow down' }, 'Juda ko‘p urinish'],
    [500, null, 'Kirishda xatolik'],
  ])('maps HTTP %i %j to a translated message', async (status, body, text) => {
    const login = vi.fn(async () => {
      throw new ApiError(status, body, 'http')
    })
    renderPage(anonymousAuth({ login }), BOT)
    await fireWidgetCallback(widgetUser)
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it.each([
    ['network', 'Tarmoq xatosi'],
    ['timeout', 'Tarmoq xatosi'],
  ] as const)('maps a %s failure', async (kind, text) => {
    const login = vi.fn(async () => {
      throw new ApiError(0, 'x', kind)
    })
    renderPage(anonymousAuth({ login }), BOT)
    await fireWidgetCallback(widgetUser)
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('shows nothing for an overtaken sign-in', async () => {
    const login = vi.fn(async () => {
      throw new SessionSupersededError()
    })
    renderPage(anonymousAuth({ login }), BOT)
    await fireWidgetCallback(widgetUser)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('never shows raw server text or the payload in the error', async () => {
    const login = vi.fn(async () => {
      throw new ApiError(400, { detail: 'SECRET-SERVER-TEXT' }, 'http')
    })
    renderPage(anonymousAuth({ login }), BOT)
    await fireWidgetCallback(widgetUser)
    expect(screen.getByRole('alert').textContent).not.toContain('SECRET-SERVER-TEXT')
  })

  it('clears the previous error when the user tries again', async () => {
    const login = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(429, null, 'http'))
      .mockResolvedValueOnce(undefined)
    renderPage(anonymousAuth({ login }), BOT)
    await fireWidgetCallback(widgetUser)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await fireWidgetCallback(widgetUser)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('redirect', () => {
  it('sends an already signed-in user to the page they came from', () => {
    renderPage(makeAuth({ role: 'ADMIN' }), { ...BOT, from: '/tariffs' })
    expect(screen.getByText('tariffs page')).toBeInTheDocument()
  })

  it('defaults to the parkings page', () => {
    renderPage(makeAuth({ role: 'OWNER' }), BOT)
    expect(screen.getByText('parkings page')).toBeInTheDocument()
  })

  it.each(['//evil.example', '/LOGIN', '/a\tb'])('ignores the redirect target %j', (from) => {
    renderPage(makeAuth({ role: 'OWNER' }), { ...BOT, from })
    expect(screen.getByText('parkings page')).toBeInTheDocument()
  })
})
