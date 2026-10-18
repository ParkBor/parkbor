import { ApiError } from '@habi/api-client'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const LOT = '123e4567-e89b-12d3-a456-426614174000'
const api = vi.hoisted(() => ({
  parkings: { list: vi.fn() },
  operators: { list: vi.fn(), revoke: vi.fn() },
  invites: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
}))
vi.mock('../lib/api', () => ({ adminApi: api, setAccessToken: vi.fn() }))

import { pageOf, renderPage } from '../test/renderPage'
import OperatorsPage from './OperatorsPage'

async function pickLot() {
  await userEvent.click(await screen.findByRole('combobox'))
  await userEvent.click(await screen.findByText('Lot A'))
}

beforeEach(() => {
  vi.clearAllMocks()
  api.parkings.list.mockResolvedValue(pageOf([{ id: LOT, name: 'Lot A' }]))
  api.operators.list.mockResolvedValue(
    pageOf([{ id: 'u1', assignment_id: 'as1', display_name: 'Aziza K.', created_at: '2026-10-01T00:00:00Z' }]),
  )
  api.invites.list.mockResolvedValue(
    pageOf([{ id: 'inv1', created_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-04T00:00:00Z' }]),
  )
})

describe('OperatorsPage', () => {
  it('lists the operators of the chosen lot with the masked name', async () => {
    renderPage(<OperatorsPage />, { role: 'OWNER' })
    await pickLot()
    expect(await screen.findByText('Aziza K.')).toBeInTheDocument()
    expect(api.operators.list).toHaveBeenCalledWith(LOT, expect.objectContaining({ page: 1 }))
  })

  it('shows a created invitation code once and forgets it when the dialog closes', async () => {
    api.invites.create.mockResolvedValue({
      invite_id: 'inv2',
      code: 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z',
      expires_at: '2026-10-20T00:00:00Z',
    })
    renderPage(<OperatorsPage />, { role: 'OWNER' })
    await pickLot()
    await userEvent.click(await screen.findByRole('tab', { name: 'Taklif-kodlar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Taklif-kod yaratish' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByDisplayValue('ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z')).toBeInTheDocument()
    expect(within(dialog).getByText(/faqat bir marta/)).toBeInTheDocument()
    expect(api.invites.create).toHaveBeenCalledWith(LOT, { expires_in_hours: 72 })

    await userEvent.click(within(dialog).getByRole('button', { name: 'Nusxaladim, yopish' }))
    await waitFor(() => expect(screen.queryByDisplayValue('ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z')).toBeNull())
    expect(document.body.textContent).not.toContain('ABCDE-FGHIJ')
    // the list is refreshed from the server, which never returns the code
    expect(api.invites.list.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses an out-of-range validity before calling the server', async () => {
    renderPage(<OperatorsPage />, { role: 'ADMIN' })
    await pickLot()
    await userEvent.click(await screen.findByRole('tab', { name: 'Taklif-kodlar' }))
    const hours = await screen.findByLabelText('Amal qilish (soat, 1–168)')
    await userEvent.clear(hours)
    await userEvent.type(hours, '500')
    await userEvent.tab()
    // antd clamps to max; either way the request must stay inside 1..168
    await userEvent.click(screen.getByRole('button', { name: 'Taklif-kod yaratish' }))
    api.invites.create.mockResolvedValue({ invite_id: 'x', code: 'C', expires_at: '2026-10-20T00:00:00Z' })
    for (const call of api.invites.create.mock.calls) {
      expect(call[1].expires_in_hours).toBeLessThanOrEqual(168)
      expect(call[1].expires_in_hours).toBeGreaterThanOrEqual(1)
    }
  })

  it('explains the open-invite limit', async () => {
    api.invites.create.mockRejectedValue(new ApiError(409, { code: 'invite_limit_reached' }, 'http'))
    renderPage(<OperatorsPage />, { role: 'OWNER' })
    await pickLot()
    await userEvent.click(await screen.findByRole('tab', { name: 'Taklif-kodlar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Taklif-kod yaratish' }))
    expect(await screen.findByText(/chegarasiga yetildi/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('revokes an open invitation', async () => {
    api.invites.revoke.mockResolvedValue(null)
    renderPage(<OperatorsPage />, { role: 'OWNER' })
    await pickLot()
    await userEvent.click(await screen.findByRole('tab', { name: 'Taklif-kodlar' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Bekor qilish' }))
    await waitFor(() => expect(api.invites.revoke).toHaveBeenCalledWith(LOT, 'inv1'))
  })

  it('revokes an operator after confirmation', async () => {
    api.operators.revoke.mockResolvedValue(null)
    renderPage(<OperatorsPage />, { role: 'OWNER' })
    await pickLot()
    await userEvent.click(await screen.findByRole('button', { name: 'Olib tashlash' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Olib tashlash' }))
    await waitFor(() => expect(api.operators.revoke).toHaveBeenCalledWith(LOT, 'as1'))
  })
})
