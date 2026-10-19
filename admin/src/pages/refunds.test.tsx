import { ApiError } from '@habi/api-client'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  refunds: { list: vi.fn(), resolve: vi.fn() },
  parkings: { list: vi.fn() },
}))
vi.mock('../lib/api', () => ({ adminApi: api, setAccessToken: vi.fn() }))

import { pageOf, renderPage } from '../test/renderPage'
import RefundsPage from './RefundsPage'

const refund = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  payment: 'p1',
  booking: '123e4567-e89b-12d3-a456-426614174000',
  amount: '6000.00',
  status: 'MANUAL',
  reason: 'cancel',
  attempts: 0,
  last_error: '',
  created_at: '2026-10-17T10:00:00Z',
  updated_at: '2026-10-17T10:00:00Z',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.parkings.list.mockResolvedValue(pageOf([]))
})

describe('RefundsPage', () => {
  it('asks the server for the needs-attention queue by default and shows money as text', async () => {
    api.refunds.list.mockResolvedValue(pageOf([refund()]))
    renderPage(<RefundsPage />)
    expect(await screen.findByText('6 000')).toBeInTheDocument()
    expect(api.refunds.list).toHaveBeenCalledWith(
      expect.objectContaining({ needs_attention: true, page: 1, page_size: 20 }),
    )
  })

  it('omits needs_attention when the toggle is off (the server then returns every refund)', async () => {
    api.refunds.list.mockResolvedValue(pageOf([refund()]))
    renderPage(<RefundsPage />)
    await screen.findByText('6 000')
    await userEvent.click(screen.getByRole('switch', { name: /Faqat qo‘lda hal qilinadiganlar/ }))
    await waitFor(() => {
      const last = api.refunds.list.mock.calls.at(-1)?.[0]
      expect(last).toBeDefined()
      expect('needs_attention' in last && last.needs_attention !== undefined).toBe(false)
    })
  })

  it('lets ADMIN settle a MANUAL refund as done with a note', async () => {
    api.refunds.list.mockResolvedValue(pageOf([refund()]))
    api.refunds.resolve.mockResolvedValue(refund({ status: 'DONE' }))
    renderPage(<RefundsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Hal qilish' }))
    const dialog = await screen.findByRole('dialog')
    // nothing is pre-selected: the confirm button stays disabled until a choice and its tick
    expect(within(dialog).getByRole('button', { name: 'Tasdiqlash' })).toBeDisabled()
    await userEvent.click(within(dialog).getByLabelText('Pul qo‘lda qaytarilgan (Bajarildi)'))
    expect(within(dialog).getByRole('button', { name: 'Tasdiqlash' })).toBeDisabled()
    await userEvent.click(within(dialog).getByLabelText('Pul haqiqatan qaytarilganini tasdiqlayman'))
    await userEvent.type(within(dialog).getByLabelText('Izoh'), 'Payme kabinetida qaytarildi')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tasdiqlash' }))
    await waitFor(() =>
      expect(api.refunds.resolve).toHaveBeenCalledWith('r1', {
        outcome: 'done',
        note: 'Payme kabinetida qaytarildi',
      }),
    )
  })

  it('blocks a note that looks like a phone or card number', async () => {
    api.refunds.list.mockResolvedValue(pageOf([refund()]))
    renderPage(<RefundsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Hal qilish' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByLabelText('Pul qo‘lda qaytarilgan (Bajarildi)'))
    await userEvent.click(within(dialog).getByLabelText('Pul haqiqatan qaytarilganini tasdiqlayman'))
    await userEvent.type(within(dialog).getByLabelText('Izoh'), 'karta 8600123412345678')
    expect(within(dialog).getByText('Izohda telefon yoki karta raqami bo‘lmasin')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Tasdiqlash' })).toBeDisabled()
    expect(api.refunds.resolve).not.toHaveBeenCalled()
  })

  it('offers retry only for FAILED refunds and warns that "failed" is final', async () => {
    api.refunds.list.mockResolvedValue(pageOf([refund({ status: 'MANUAL' })]))
    renderPage(<RefundsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Hal qilish' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('Provayderga qayta yuborish')).toBeNull()
    await userEvent.click(within(dialog).getByLabelText('Qaytarilmaydi (yakuniy)'))
    expect(within(dialog).getByText(/zaxira summa to‘lovga qaytadi/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Tasdiqlash' })).toBeDisabled()
    await userEvent.click(within(dialog).getByLabelText('Bu amal yakuniy ekanini tushunaman'))
    expect(within(dialog).getByRole('button', { name: 'Tasdiqlash' })).toBeEnabled()
  })

  it('shows the server conflict inside the dialog and keeps it open', async () => {
    api.refunds.list.mockResolvedValue(pageOf([refund({ status: 'FAILED', last_error: 'retries_exhausted' })]))
    api.refunds.resolve.mockRejectedValue(
      new ApiError(409, { detail: 'internal text', code: 'reservation_mismatch' }, 'http'),
    )
    renderPage(<RefundsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Hal qilish' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByLabelText('Provayderga qayta yuborish'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tasdiqlash' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Zaxira summa mos kelmadi')
    expect(screen.queryByText('internal text')).toBeNull()
  })

  it('closes the dialog and refetches the queue when the refund changed meanwhile', async () => {
    api.refunds.list.mockResolvedValue(pageOf([refund({ status: 'FAILED', last_error: 'retries_exhausted' })]))
    api.refunds.resolve.mockRejectedValue(
      new ApiError(409, { detail: 'x', code: 'invalid_transition' }, 'http'),
    )
    renderPage(<RefundsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Hal qilish' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByLabelText('Provayderga qayta yuborish'))
    const before = api.refunds.list.mock.calls.length
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tasdiqlash' }))
    await waitFor(() => expect(api.refunds.list.mock.calls.length).toBeGreaterThan(before))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('offers retry for a FAILED refund whatever its error code', async () => {
    api.refunds.list.mockResolvedValue(pageOf([refund({ status: 'FAILED', last_error: 'click_error_-5' })]))
    renderPage(<RefundsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Hal qilish' }))
    expect(await screen.findByLabelText('Provayderga qayta yuborish')).toBeInTheDocument()
  })

  it('hides the resolve action from an OWNER (read-only) ', async () => {
    api.refunds.list.mockResolvedValue(pageOf([refund()]))
    renderPage(<RefundsPage />, { role: 'OWNER' })
    expect(await screen.findByText('6 000')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hal qilish' })).toBeNull()
  })

  it('has no resolve button for final or in-flight refunds', async () => {
    api.refunds.list.mockResolvedValue(
      pageOf([
        refund({ id: 'a', status: 'SENT' }),
        refund({ id: 'b', status: 'FAILED', last_error: 'operator_failed' }),
      ]),
    )
    renderPage(<RefundsPage />)
    expect(await screen.findAllByText('6 000')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Hal qilish' })).toBeNull()
  })

  it('says so when the backend has no refunds endpoint', async () => {
    api.refunds.list.mockRejectedValue(new ApiError(404, null, 'http'))
    renderPage(<RefundsPage />)
    expect(await screen.findByText(/serverda hali mavjud emas/)).toBeInTheDocument()
  })
})
