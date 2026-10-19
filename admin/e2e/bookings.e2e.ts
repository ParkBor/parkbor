import { booking, uuid } from './support/fixtures'
import { expect, openMenu, pickOption, signIn, test } from './support/app'
import { t } from './support/i18n'

test.describe('bookings list', () => {
  test('filters by status and by plate number on the server', async ({ page, api }) => {
    await signIn(page, api)
    await openMenu(page, 'nav.bookings')
    await expect(page.getByRole('row')).toHaveCount(4) // header + 3 bookings
    await expect(page.getByText('01B222XY')).toBeVisible()

    await pickOption(page, t('bookings.status'), t('status.booking.COMPLETED'))
    await expect(page.getByRole('row')).toHaveCount(2)
    await expect(page.getByText('01B222XY')).toBeVisible()
    await expect(page.getByText('01A101BC')).toHaveCount(0)
    expect(api.callsTo('GET', '/admin/bookings').at(-1)?.query).toMatchObject({ status: 'COMPLETED', page: '1' })

    // Clear the status filter, then search by plate (Enter submits the search box).
    await page.locator('.ant-select', { has: page.getByRole('combobox', { name: t('bookings.status'), exact: true }) }).hover()
    await page.locator('.ant-select-clear').first().click()
    await page.getByRole('searchbox', { name: t('bookings.plate') }).fill('c333')
    await page.getByRole('searchbox', { name: t('bookings.plate') }).press('Enter')
    await expect(page.getByRole('row')).toHaveCount(2)
    await expect(page.getByText('01C333ZZ')).toBeVisible()
    expect(api.callsTo('GET', '/admin/bookings').at(-1)?.query).toMatchObject({ search: 'c333' })
  })

  test('shows the empty state when nothing matches', async ({ page, api }) => {
    api.bookings = []
    await signIn(page, api)
    await openMenu(page, 'nav.bookings')
    await expect(page.getByText(t('common.noData'))).toBeVisible()
  })
})

test.describe('booking detail and cancel', () => {
  test('opens a booking from the list and shows amounts, status and history', async ({ page, api }) => {
    await signIn(page, api)
    await openMenu(page, 'nav.bookings')
    await page.getByRole('link', { name: uuid(1001).slice(0, 8) }).click()

    await expect(page).toHaveURL(new RegExp(`/bookings/${uuid(1001)}$`))
    await expect(page.getByRole('heading', { name: new RegExp(t('bookings.detailTitle')) })).toBeVisible()
    await expect(page.getByText('01A101BC')).toBeVisible()
    await expect(page.getByText('12 000').first()).toBeVisible()
    await expect(page.getByText(/PENDING_PAYMENT|Awaiting payment/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: t('bookings.cancel') })).toBeVisible()
  })

  test('cancel asks for a reason, sends it once even when clicked twice, then refreshes', async ({ page, api }) => {
    await signIn(page, api)
    await openMenu(page, 'nav.bookings')
    await page.getByRole('link', { name: uuid(1001).slice(0, 8) }).click()
    await page.getByRole('button', { name: t('bookings.cancel') }).click()

    const dialog = page.getByRole('dialog', { name: t('bookings.cancelTitle') })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(t('bookings.cancelRefundNote'))).toBeVisible()
    await dialog.getByRole('textbox', { name: t('bookings.cancelReason') }).fill('Lot closed for repairs')
    // The mock answers after 300 ms, so the second click lands while the first is in flight.
    const confirm = dialog.getByRole('button', { name: t('bookings.cancelConfirm') })
    await confirm.click()
    await confirm.click({ noWaitAfter: true, force: true }).catch(() => undefined)

    await expect(page.getByText(t('bookings.cancelled'))).toBeVisible()
    await expect(dialog).toBeHidden()
    const posts = api.callsTo('POST', `/admin/bookings/${uuid(1001)}/cancel`)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ reason: 'Lot closed for repairs' })
    // The detail was refetched and no longer offers cancelling.
    await expect(page.getByText(/CANCELLED|Cancelled/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: t('bookings.cancel') })).toHaveCount(0)
  })

  // Two clicks in the same instant (Playwright dblclick): BookingDetailPage guards the cancel with a
  // synchronous ref (useSingleFlight), so only one POST goes out.
  test('cancel: a same-instant double click still sends one request', async ({ page, api }) => {
    await signIn(page, api)
    await openMenu(page, 'nav.bookings')
    await page.getByRole('link', { name: uuid(1001).slice(0, 8) }).click()
    await page.getByRole('button', { name: t('bookings.cancel') }).click()
    const dialog = page.getByRole('dialog', { name: t('bookings.cancelTitle') })
    await dialog.getByRole('button', { name: t('bookings.cancelConfirm') }).dblclick()
    await expect(page.getByText(t('bookings.cancelled'))).toBeVisible()
    expect(api.callsTo('POST', /\/cancel$/)).toHaveLength(1)
  })

  test('closing the dialog without confirming sends nothing; the reason is not kept', async ({ page, api }) => {
    await signIn(page, api)
    await openMenu(page, 'nav.bookings')
    await page.getByRole('link', { name: uuid(1001).slice(0, 8) }).click()
    await page.getByRole('button', { name: t('bookings.cancel') }).click()
    const dialog = page.getByRole('dialog', { name: t('bookings.cancelTitle') })
    await dialog.getByRole('textbox', { name: t('bookings.cancelReason') }).fill('typed then abandoned')
    await dialog.getByRole('button', { name: t('common.cancel'), exact: true }).click()
    await expect(dialog).toBeHidden()

    await page.getByRole('button', { name: t('bookings.cancel') }).click()
    await expect(page.getByRole('textbox', { name: t('bookings.cancelReason') })).toHaveValue('')
    expect(api.callsTo('POST', /\/cancel$/)).toHaveLength(0)
  })

  test('a 409 from the server (already completed elsewhere) is reported, not swallowed', async ({ page, api }) => {
    api.bookings = [booking(1)]
    await signIn(page, api)
    await openMenu(page, 'nav.bookings')
    await page.getByRole('link', { name: uuid(1001).slice(0, 8) }).click()
    await page.getByRole('button', { name: t('bookings.cancel') }).click()
    api.override('POST', /\/cancel$/, () => ({ status: 409, json: { detail: 'Invalid transition', code: 'invalid_transition' } }))
    await page.getByRole('button', { name: t('bookings.cancelConfirm') }).click()

    await expect(page.getByText(t('common.error'))).toBeVisible()
    await expect(page.getByText(t('bookings.cancelled'))).toHaveCount(0)
  })

  test('a detail id that is not a UUID gets a not-found page without an API call', async ({ page, api }) => {
    await signIn(page, api)
    await page.evaluate(() => {
      window.history.pushState({}, '', '/bookings/not-a-uuid')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page.getByText(t('common.notFound'))).toBeVisible()
    expect(api.callsTo('GET', /^\/admin\/bookings\/not-a-uuid/)).toHaveLength(0)
  })
})
