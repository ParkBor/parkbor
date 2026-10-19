import { expect, goTo, menuLabels, openMenu, signIn, test } from './support/app'
import { t } from './support/i18n'
import { refund } from './support/fixtures'

const ADMIN_ONLY = [
  { path: '/users', nav: 'nav.users', endpoint: '/admin/users' },
  { path: '/settings', nav: 'nav.settings', endpoint: '/admin/settings' },
  { path: '/audit', nav: 'nav.audit', endpoint: '/admin/audit-logs' },
  { path: '/moderation', nav: 'nav.moderation', endpoint: '/admin/parkings' },
] as const

const SHARED_NAV = ['nav.dashboard', 'nav.parkings', 'nav.bookings', 'nav.payments', 'nav.refunds', 'nav.operators', 'nav.reviews']

test.describe('OWNER', () => {
  test('has no menu entries for admin-only sections', async ({ page, api }) => {
    await signIn(page, api, 'OWNER')
    const labels = await menuLabels(page)

    for (const key of SHARED_NAV) expect(labels).toContain(t(key))
    for (const { nav } of ADMIN_ONLY) expect(labels).not.toContain(t(nav))
  })

  for (const { path, endpoint } of ADMIN_ONLY) {
    test(`is shown the 403 screen on ${path} and the API is never asked`, async ({ page, api }) => {
      await signIn(page, api, 'OWNER')
      await goTo(page, path)

      await expect(page.getByText(t('auth.forbidden.title'))).toBeVisible()
      await expect(page.getByText(t('auth.forbidden.section'))).toBeVisible()
      // The shell is still there so the owner can go back.
      await expect(page.getByRole('menu')).toBeVisible()
      if (path !== '/moderation') expect(api.callsTo('GET', endpoint)).toHaveLength(0)
    })
  }

  test('can read refunds but gets no Resolve button; cancel and export stay available', async ({ page, api }) => {
    api.refunds = [refund(1)]
    await signIn(page, api, 'OWNER')
    await openMenu(page, 'nav.refunds')

    await expect(page.getByRole('heading', { name: t('refunds.title') })).toBeVisible()
    await expect(page.getByRole('row', { name: /MANUAL|Manual/ })).toBeVisible()
    await expect(page.getByRole('button', { name: t('refunds.resolve') })).toHaveCount(0)
    await openMenu(page, 'nav.bookings')
    await expect(page.getByRole('button', { name: t('export.button') })).toBeVisible()
  })
})

test.describe('ADMIN', () => {
  test('sees every admin-only entry and can open each section', async ({ page, api }) => {
    await signIn(page, api, 'ADMIN')
    const labels = await menuLabels(page)
    for (const { nav } of ADMIN_ONLY) expect(labels).toContain(t(nav))

    await openMenu(page, 'nav.users')
    await expect(page.getByRole('heading', { name: t('users.title') })).toBeVisible()
    await openMenu(page, 'nav.settings')
    await expect(page.getByRole('heading', { name: t('settings.title') })).toBeVisible()
    await openMenu(page, 'nav.audit')
    await expect(page.getByText('user.block')).toBeVisible()
    await openMenu(page, 'nav.moderation')
    await expect(page.getByRole('heading', { name: t('moderation.title') })).toBeVisible()
    await expect(page.getByText(t('auth.forbidden.section'))).toHaveCount(0)
  })

  test('sees the Resolve button on a MANUAL refund', async ({ page, api }) => {
    await signIn(page, api, 'ADMIN')
    await openMenu(page, 'nav.refunds')
    await expect(page.getByRole('button', { name: t('refunds.resolve') })).toBeVisible()
  })
})

test.describe('other roles', () => {
  for (const role of ['DRIVER', 'OPERATOR'] as const) {
    test(`${role} signs in but only gets the whole-app 403 screen`, async ({ page, api }) => {
      api.role = role
      await page.goto('/login')
      await page.getByTestId('mock-telegram-login').click()

      await expect(page.getByText(t('auth.forbidden.title'))).toBeVisible()
      await expect(page.getByText(t('auth.forbidden.description'))).toBeVisible()
      await expect(page.getByRole('menu')).toHaveCount(0)
      // Not a single admin endpoint is requested for a non-staff role.
      expect(api.calls.filter((c) => c.path.startsWith('/admin'))).toHaveLength(0)
      await page.getByRole('button', { name: t('auth.logout') }).click()
      await expect(page).toHaveURL(/\/login/)
    })
  }
})
