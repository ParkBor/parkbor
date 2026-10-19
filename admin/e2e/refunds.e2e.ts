import { refund } from './support/fixtures'
import { expect, openMenu, signIn, test } from './support/app'
import { t } from './support/i18n'
import type { Page } from '@playwright/test'

async function openRefunds(page: Page): Promise<void> {
  await openMenu(page, 'nav.refunds')
  await expect(page.getByRole('heading', { name: t('refunds.title') })).toBeVisible()
}

function dialogOf(page: Page) {
  return page.getByRole('dialog', { name: t('refunds.resolveTitle') })
}

test.describe('manual refund queue', () => {
  test.beforeEach(async ({ api }) => {
    api.refunds = [
      refund(1),
      refund(2, { status: 'FAILED', last_error: 'click_error_-9' }),
      refund(3, { status: 'FAILED', last_error: 'operator_failed' }),
      refund(4, { status: 'DONE', last_error: '' }),
    ]
  })

  test('shows the needs-attention queue by default and widens it with the switch', async ({ page, api }) => {
    await signIn(page, api)
    await openRefunds(page)

    expect(api.callsTo('GET', '/admin/refunds')[0].query).toMatchObject({ needs_attention: 'true' })
    // MANUAL and the retryable FAILED; the final operator_failed one and the DONE one are not queued.
    await expect(page.getByRole('row')).toHaveCount(3)
    await expect(page.getByRole('button', { name: t('refunds.resolve') })).toHaveCount(2)

    await page.getByRole('switch', { name: t('refunds.needsAttention') }).click()
    await expect(page.getByRole('row')).toHaveCount(5)
    expect(api.callsTo('GET', '/admin/refunds').at(-1)?.query.needs_attention).toBeUndefined()
    // A final refund has no Resolve button at all.
    await expect(page.getByRole('button', { name: t('refunds.resolve') })).toHaveCount(2)
  })

  test('the dialog starts with no outcome chosen and the confirm button disabled', async ({ page, api }) => {
    await signIn(page, api)
    await openRefunds(page)
    await page.getByRole('row', { name: /Manual/ }).getByRole('button', { name: t('refunds.resolve') }).click()

    const dialog = dialogOf(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('radio')).toHaveCount(2) // MANUAL: done | failed
    for (const radio of await dialog.getByRole('radio').all()) await expect(radio).not.toBeChecked()
    await expect(dialog.getByText(t('refunds.chooseOutcome'))).toBeVisible()
    await expect(dialog.getByRole('button', { name: t('refunds.confirm') })).toBeDisabled()
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  })

  test('"will not be refunded" needs the tick box before it can be sent', async ({ page, api }) => {
    await signIn(page, api)
    await openRefunds(page)
    await page.getByRole('row', { name: /Manual/ }).getByRole('button', { name: t('refunds.resolve') }).click()
    const dialog = dialogOf(page)
    const confirm = dialog.getByRole('button', { name: t('refunds.confirm') })

    await dialog.getByRole('radio', { name: t('refunds.outcomes.failed') }).check()
    await expect(dialog.getByText(t('refunds.failedWarning'))).toBeVisible()
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('textbox', { name: t('refunds.note') }).fill('Client left, wrote off')
    await expect(confirm).toBeDisabled() // a note alone is not enough
    await dialog.getByRole('checkbox', { name: t('refunds.confirmFailed') }).check()
    await expect(confirm).toBeEnabled()
    // Switching the outcome clears the confirmation again.
    await dialog.getByRole('radio', { name: t('refunds.outcomes.done') }).check()
    await expect(dialog.getByRole('checkbox', { name: t('refunds.confirmDone') })).not.toBeChecked()
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('radio', { name: t('refunds.outcomes.failed') }).check()
    await dialog.getByRole('checkbox', { name: t('refunds.confirmFailed') }).check()
    await confirm.click()

    await expect(page.getByText(t('refunds.resolved'))).toBeVisible()
    await expect(dialog).toBeHidden()
    const posts = api.callsTo('POST', /\/refunds\/.+\/resolve$/)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ outcome: 'failed', note: 'Client left, wrote off' })
    // The queue was refetched: the settled refund left it.
    await expect(page.getByRole('row')).toHaveCount(2)
  })

  test('a note with a phone or card number is blocked before anything is sent', async ({ page, api }) => {
    await signIn(page, api)
    await openRefunds(page)
    await page.getByRole('row', { name: /Manual/ }).getByRole('button', { name: t('refunds.resolve') }).click()
    const dialog = dialogOf(page)
    await dialog.getByRole('radio', { name: t('refunds.outcomes.done') }).check()
    await dialog.getByRole('checkbox', { name: t('refunds.confirmDone') }).check()
    await dialog.getByRole('textbox', { name: t('refunds.note') }).fill('card 8600 1234 5678 9012')

    await expect(dialog.getByText(t('refunds.noteProblems.sensitive'))).toBeVisible()
    await expect(dialog.getByRole('button', { name: t('refunds.confirm') })).toBeDisabled()
    expect(api.callsTo('POST', /resolve$/)).toHaveLength(0)
  })

  test('a 409 stale row closes the dialog, warns, and refetches the queue', async ({ page, api }) => {
    await signIn(page, api)
    await openRefunds(page)
    const listCalls = () => api.callsTo('GET', '/admin/refunds').length
    const before = listCalls()
    // Meanwhile somebody else settled that refund: the server now refuses the transition.
    api.refunds = api.refunds.map((r) => (r.status === 'MANUAL' ? { ...r, status: 'DONE' as const, last_error: '' } : r))
    api.override('POST', /resolve$/, () => ({ status: 409, json: { detail: 'Invalid transition', code: 'invalid_transition' } }))

    await page.getByRole('row', { name: /Manual/ }).getByRole('button', { name: t('refunds.resolve') }).click()
    const dialog = dialogOf(page)
    await dialog.getByRole('radio', { name: t('refunds.outcomes.done') }).check()
    await dialog.getByRole('checkbox', { name: t('refunds.confirmDone') }).check()
    await dialog.getByRole('button', { name: t('refunds.confirm') }).click()

    await expect(page.getByText(t('refunds.stale'))).toBeVisible()
    await expect(dialog).toBeHidden()
    await expect.poll(listCalls).toBeGreaterThan(before)
    await expect(page.getByRole('row', { name: /Manual/ })).toHaveCount(0)
    await expect(page.getByText(t('refunds.resolved'))).toHaveCount(0)
  })

  test('other server refusals stay inside the dialog so the person can fix them', async ({ page, api }) => {
    await signIn(page, api)
    await openRefunds(page)
    api.override('POST', /resolve$/, () => ({ status: 409, json: { detail: 'x', code: 'reservation_mismatch' } }))
    await page.getByRole('row', { name: /Manual/ }).getByRole('button', { name: t('refunds.resolve') }).click()
    const dialog = dialogOf(page)
    await dialog.getByRole('radio', { name: t('refunds.outcomes.done') }).check()
    await dialog.getByRole('checkbox', { name: t('refunds.confirmDone') }).check()
    await dialog.getByRole('button', { name: t('refunds.confirm') }).click()

    await expect(dialog.getByRole('alert')).toContainText(t('refunds.errors.reservation_mismatch'))
    await expect(dialog).toBeVisible()
  })
})
