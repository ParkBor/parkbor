import { expect, goTo, openMenu, pickOption, signIn, storageDump, test } from './support/app'
import { DRF_NOT_FOUND } from './support/mockApi'
import { t, tr } from './support/i18n'

test.describe('login and dashboard', () => {
  test('signing in with the Telegram widget lands on a dashboard with stats', async ({ page, api }) => {
    await signIn(page, api, 'ADMIN')

    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: t('dashboard.title') })).toBeVisible()
    const bookingsToday = page.locator('.ant-statistic', { hasText: t('dashboard.bookingsToday') })
    await expect(bookingsToday).toContainText('17')
    await expect(page.locator('.ant-statistic', { hasText: t('dashboard.revenueMonth') })).toContainText('48 500 000')
    await expect(page.getByText('62.50%')).toBeVisible()
    await expect(page.getByText('Chilonzor Parking')).toBeVisible()
    // The widget payload went to the login endpoint exactly as the widget produced it.
    const login = api.callsTo('POST', '/auth/telegram/widget')
    expect(login).toHaveLength(1)
    expect(login[0].body).toMatchObject({ id: 777001, hash: 'e2e-widget-hash' })
  })

  test('no token is kept in localStorage, sessionStorage, cookies or the URL', async ({ page, api }) => {
    await signIn(page, api)
    await expect(page.getByRole('heading', { name: t('dashboard.title') })).toBeVisible()
    await goTo(page, '/bookings')
    await expect(page.getByRole('heading', { name: t('bookings.title') })).toBeVisible()

    // The API calls DID carry a bearer token (the session works) ...
    const authed = api.callsTo('GET', '/admin/stats/overview')[0]
    expect(authed.authorization).toMatch(/^Bearer e2e-access-token-\d+$/)
    // ... but it is nowhere the page could persist or leak it.
    const dump = await storageDump(page)
    expect(dump).not.toContain('e2e-access-token')
    expect(dump).not.toContain('e2e-refresh-token')
    expect(dump).not.toMatch(/token|jwt|bearer/i)
  })

  test('a page reload drops the memory-only session and returns to the login screen', async ({ page, api }) => {
    await signIn(page, api)
    await page.reload()
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByTestId('widget-area')).toBeVisible()
  })

  test('logging out clears the session and revokes the refresh token', async ({ page, api }) => {
    await signIn(page, api)
    await page.getByRole('button', { name: t('auth.logout') }).click()
    await expect(page).toHaveURL(/\/login/)
    await expect.poll(() => api.callsTo('POST', '/auth/logout').length).toBe(1)
    expect(api.callsTo('POST', '/auth/logout')[0].body).toMatchObject({ refresh: expect.stringContaining('e2e-refresh-token') })
  })
})

test.describe('session expiry', () => {
  test('a 401 whose refresh is also rejected sends the user back to login', async ({ page, api }) => {
    await signIn(page, api)
    await expect(page.getByRole('heading', { name: t('dashboard.title') })).toBeVisible()

    api.refreshRejected = true
    api.override('GET', /^\/admin\/bookings$/, () => ({ status: 401, json: { detail: 'Token expired', code: 'token_not_valid' } }))
    await openMenu(page, 'nav.bookings')

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByTestId('widget-area')).toBeVisible()
    expect(api.callsTo('POST', '/auth/token/refresh').length).toBeGreaterThanOrEqual(1)
    // No stale admin data stays reachable: the menu is gone.
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('a 401 that a refresh can fix is retried silently and the user stays signed in', async ({ page, api }) => {
    await signIn(page, api)
    let first = true
    api.override('GET', /^\/admin\/bookings$/, () => {
      if (!first) return undefined
      first = false
      return { status: 401, json: { detail: 'Token expired', code: 'token_not_valid' } }
    })
    await openMenu(page, 'nav.bookings')

    await expect(page.getByRole('heading', { name: t('bookings.title') })).toBeVisible()
    await expect(page).toHaveURL(/\/bookings$/)
    expect(api.callsTo('POST', '/auth/token/refresh')).toHaveLength(1)
    await expect(page.getByText('01A101BC')).toBeVisible()
  })
})

test.describe('language', () => {
  test('switching uz / ru / en changes <html lang> and the texts', async ({ page, api }) => {
    await signIn(page, api)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByRole('heading', { name: tr('en', 'dashboard.title') })).toBeVisible()

    let current: 'uz' | 'ru' | 'en' = 'en'
    for (const lang of ['ru', 'uz', 'en'] as const) {
      // The select's accessible name is itself translated, so look it up in the current language.
      await pickOption(page, tr(current, 'common.language'), lang.toUpperCase())
      current = lang
      await expect(page.locator('html')).toHaveAttribute('lang', lang)
      await expect(page.getByRole('heading', { name: tr(lang, 'dashboard.title') })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: tr(lang, 'nav.bookings'), exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: tr(lang, 'auth.logout') })).toBeVisible()
    }
  })

  test('the login screen can be switched too and the choice is remembered after a reload', async ({ page, api }) => {
    await page.goto('/login')
    await pickOption(page, t('common.language'), 'RU')
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
    await expect(page.getByText(tr('ru', 'auth.subtitle'))).toBeVisible()

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
    await expect(page.getByText(tr('ru', 'auth.subtitle'))).toBeVisible()
    expect(api.calls).toHaveLength(0)
  })
})

test.describe('failure states', () => {
  test('a 404 without a DRF body shows the "not available" notice, a DRF 404 does not', async ({ page, api }) => {
    await signIn(page, api)
    // Default mock answers an unknown URL with a plain-text 404, like a backend lacking the route.
    api.override('GET', '/admin/audit-logs', () => ({ status: 404, text: 'Not Found', contentType: 'text/html' }))
    await goTo(page, '/audit')
    await expect(page.getByText(t('common.endpointUnavailable'))).toBeVisible()

    api.override('GET', '/admin/audit-logs', () => ({ status: 404, json: DRF_NOT_FOUND }))
    await goTo(page, '/dashboard')
    await goTo(page, '/audit')
    await expect(page.getByText(t('common.notFound'), { exact: true })).toBeVisible()
    await expect(page.getByText(t('common.endpointUnavailable'))).toHaveCount(0)
  })

  test('a missing lazy chunk (deploy mismatch) shows the error boundary, not a blank page', async ({ page, api }) => {
    await signIn(page, api)
    await page.route('**/assets/ReviewsPage-*.js', (route) => route.fulfill({ status: 404, body: 'gone' }))
    await openMenu(page, 'nav.reviews')

    await expect(page.getByText(t('boundary.chunkTitle'))).toBeVisible()
    await expect(page.getByText(t('boundary.chunkDescription'))).toBeVisible()
    await expect(page.getByRole('button', { name: t('boundary.reload') })).toBeVisible()
    // The chunk is outdated: retrying in place is pointless, so only "reload" is offered.
    await expect(page.getByRole('button', { name: t('common.retry') })).toHaveCount(0)
    // The shell survives: another section still works, and the session is intact.
    await openMenu(page, 'nav.dashboard')
    await expect(page.getByRole('heading', { name: t('dashboard.title') })).toBeVisible()
    await expect(page.getByText(t('boundary.chunkTitle'))).toHaveCount(0)
  })
})
