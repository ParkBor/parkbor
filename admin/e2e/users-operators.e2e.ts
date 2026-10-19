import { expect, openMenu, pickOption, signIn, storageDump, test } from './support/app'
import { INVITE_CODE } from './support/mockApi'
import { LOT_A, user, uuid } from './support/fixtures'
import { t } from './support/i18n'

test.describe('users: block and unblock', () => {
  test.beforeEach(async ({ api }) => {
    api.users = [user(1, { first_name: 'Aziza', last_name: 'K' }), user(2, { first_name: 'Bobur', last_name: 'T', is_active: false })]
  })

  test('blocking asks for confirmation, then sends is_active=false', async ({ page, api }) => {
    await signIn(page, api)
    await openMenu(page, 'nav.users')
    const row = page.getByRole('row', { name: /Aziza K/ })
    await expect(row).toContainText(t('users.active'))

    await row.getByRole('button', { name: t('users.block') }).click()
    const confirm = page.getByRole('dialog')
    await expect(confirm).toContainText(t('users.confirmBlock').replace('{{name}}', 'Aziza K'))
    await confirm.getByRole('button', { name: t('users.block') }).click()

    await expect(page.getByText(t('common.saved'))).toBeVisible()
    await expect(row).toContainText(t('users.blocked'))
    const patches = api.callsTo('PATCH', `/admin/users/${uuid(4001)}`)
    expect(patches).toHaveLength(1)
    expect(patches[0].body).toEqual({ is_active: false })
  })

  test('cancelling the confirmation changes nothing', async ({ page, api }) => {
    await signIn(page, api)
    await openMenu(page, 'nav.users')
    await page.getByRole('row', { name: /Aziza K/ }).getByRole('button', { name: t('users.block') }).click()
    await page.getByRole('dialog').getByRole('button', { name: t('common.cancel') }).click()

    await expect(page.getByRole('dialog')).toBeHidden()
    expect(api.callsTo('PATCH', /\/admin\/users\//)).toHaveLength(0)
    await expect(page.getByRole('row', { name: /Aziza K/ })).toContainText(t('users.active'))
  })

  test('unblocking a blocked user sends is_active=true', async ({ page, api }) => {
    await signIn(page, api)
    await openMenu(page, 'nav.users')
    const row = page.getByRole('row', { name: /Bobur T/ })
    await expect(row).toContainText(t('users.blocked'))
    await row.getByRole('button', { name: t('users.unblock') }).click()
    await page.getByRole('dialog').getByRole('button', { name: t('users.unblock') }).click()

    await expect(row).toContainText(t('users.active'))
    expect(api.callsTo('PATCH', `/admin/users/${uuid(4002)}`)[0].body).toEqual({ is_active: true })
  })

  test('a server refusal (last admin) is explained and the row stays unchanged', async ({ page, api }) => {
    api.override('PATCH', /\/admin\/users\//, () => ({ status: 409, json: { detail: 'x', code: 'last_admin' } }))
    await signIn(page, api)
    await openMenu(page, 'nav.users')
    const row = page.getByRole('row', { name: /Aziza K/ })
    await row.getByRole('button', { name: t('users.block') }).click()
    await page.getByRole('dialog').getByRole('button', { name: t('users.block') }).click()

    await expect(page.getByText(t('users.errors.last_admin'))).toBeVisible()
    await expect(row).toContainText(t('users.active'))
  })
})

test.describe('operators: one-time invitation code', () => {
  test('the code is shown once; after closing it is gone from the page, storage and URL', async ({ page, api }) => {
    await signIn(page, api, 'OWNER')
    await openMenu(page, 'nav.operators')
    await pickOption(page, t('bookings.lot'), LOT_A.name)
    await page.getByRole('tab', { name: t('operators.tabInvites') }).click()
    await page.getByRole('spinbutton', { name: t('operators.validHours') }).fill('24')
    await page.getByRole('button', { name: t('operators.createInvite') }).click()

    const dialog = page.getByRole('dialog', { name: t('operators.codeTitle') })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: t('operators.code') })).toHaveValue(INVITE_CODE)
    await expect(dialog.getByText(t('operators.codeOnce'))).toBeVisible()
    expect(api.callsTo('POST', `/admin/parkings/${LOT_A.id}/operator-invites`)[0].body).toEqual({ expires_in_hours: 24 })

    // It cannot be dismissed by accident: Escape and the backdrop do nothing.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await page.mouse.click(5, 5)
    await expect(dialog).toBeVisible()
    // While it is open the code is still not in any storage or the URL.
    expect(await storageDump(page)).not.toContain(INVITE_CODE)

    await dialog.getByRole('button', { name: t('operators.codeClose') }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText(INVITE_CODE)).toHaveCount(0)
    expect(await page.content()).not.toContain(INVITE_CODE)
    expect(await storageDump(page)).not.toContain(INVITE_CODE)
    // Re-reading the list (switch tab and back) does not bring it back: the server has no copy.
    await page.getByRole('tab', { name: t('operators.tabOperators') }).click()
    await page.getByRole('tab', { name: t('operators.tabInvites') }).click()
    expect(await page.content()).not.toContain(INVITE_CODE)
    expect(api.callsTo('POST', /operator-invites$/)).toHaveLength(1)
  })

  test('an empty validity disables creation and an oversized one is clamped to 168 hours', async ({ page, api }) => {
    await signIn(page, api, 'ADMIN')
    await openMenu(page, 'nav.operators')
    await pickOption(page, t('bookings.lot'), LOT_A.name)
    await page.getByRole('tab', { name: t('operators.tabInvites') }).click()
    const hours = page.getByRole('spinbutton', { name: t('operators.validHours') })
    const create = page.getByRole('button', { name: t('operators.createInvite') })

    await hours.fill('')
    await expect(create).toBeDisabled()
    await hours.fill('500')
    await hours.blur()
    await expect(hours).toHaveValue('168')
    await create.click()
    await expect(page.getByRole('dialog', { name: t('operators.codeTitle') })).toBeVisible()
    expect(api.callsTo('POST', /operator-invites$/)[0].body).toEqual({ expires_in_hours: 168 })
  })

  test('hitting the open-invite limit shows a clear message and no dialog', async ({ page, api }) => {
    api.override('POST', /operator-invites$/, () => ({ status: 409, json: { detail: 'limit', code: 'invite_limit_reached' } }))
    await signIn(page, api, 'OWNER')
    await openMenu(page, 'nav.operators')
    await pickOption(page, t('bookings.lot'), LOT_A.name)
    await page.getByRole('tab', { name: t('operators.tabInvites') }).click()
    await page.getByRole('button', { name: t('operators.createInvite') }).click()

    await expect(page.getByText(t('operators.limitReached'))).toBeVisible()
    await expect(page.getByRole('dialog', { name: t('operators.codeTitle') })).toHaveCount(0)
  })
})
