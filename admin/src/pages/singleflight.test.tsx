import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  parkings: { list: vi.fn(), approve: vi.fn(), suspend: vi.fn(), restore: vi.fn() },
  users: { list: vi.fn(), update: vi.fn() },
  bookings: { get: vi.fn(), cancel: vi.fn() },
  reviews: { list: vi.fn(), hide: vi.fn(), publish: vi.fn() },
}))
vi.mock('../lib/api', () => ({ adminApi: api, setAccessToken: vi.fn() }))

import { pageOf, renderPage } from '../test/renderPage'
import BookingDetailPage from './BookingDetailPage'
import ReviewsPage from './ReviewsPage'
import UsersPage from './UsersPage'

const BOOKING_ID = '123e4567-e89b-12d3-a456-426614174000'
const detail = {
  id: BOOKING_ID,
  status: 'CONFIRMED',
  kind: 'ONLINE',
  plate_number: '01A',
  slot: { id: 's', code: 'A-1', zone: 'A', floor: 1, type: 'STANDARD' },
  parking_lot: { id: 'l', name: 'Lot A' },
  start: '2026-10-17T10:00:00Z',
  end: '2026-10-17T12:00:00Z',
  amount: '1.00',
  paid_amount: '1.00',
  refund_amount: '0.00',
  refund_status: 'none',
  payment_provider: 'payme',
  checked_in_at: null,
  checked_out_at: null,
  cancelled_at: null,
  overstay_minutes: 0,
  overstay_amount: '0.00',
  overstay_status: 'none',
  overstay_needs_review: false,
  created_at: '2026-10-17T09:00:00Z',
  events: [],
  payments: [],
  refunds: [],
}

function hold() {
  let release: (value: unknown) => void = () => undefined
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.parkings.list.mockResolvedValue(pageOf([]))
})

describe('same-instant double clicks send one request', () => {
  it('cancel booking: two synchronous clicks on the confirm button', async () => {
    const gate = hold()
    api.bookings.get.mockResolvedValue(detail)
    api.bookings.cancel.mockReturnValue(gate.promise)
    renderPage(<BookingDetailPage />, { path: `/bookings/${BOOKING_ID}`, route: '/bookings/:id' })
    await userEvent.click(await screen.findByRole('button', { name: 'Bronni bekor qilish' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Ha, bekor qilish' })
    fireEvent.click(confirm)
    fireEvent.click(confirm) // same tick: React has not re-rendered a loading button yet
    gate.release({})
    await waitFor(() => expect(api.bookings.cancel).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(api.bookings.cancel).toHaveBeenCalledTimes(1)
  })

  it('cancel booking: a second click after a fast server response is dropped too', async () => {
    api.bookings.get.mockResolvedValue(detail)
    api.bookings.cancel.mockResolvedValue({})
    renderPage(<BookingDetailPage />, { path: `/bookings/${BOOKING_ID}`, route: '/bookings/:id' })
    await userEvent.click(await screen.findByRole('button', { name: 'Bronni bekor qilish' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Ha, bekor qilish' })
    fireEvent.click(confirm)
    await waitFor(() => expect(api.bookings.cancel).toHaveBeenCalledTimes(1))
    fireEvent.click(confirm) // the request is already finished, the dialog is still closing
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(api.bookings.cancel).toHaveBeenCalledTimes(1)
  })

  it('block user: two synchronous clicks on the confirm button', async () => {
    const gate = hold()
    api.users.list.mockResolvedValue(
      pageOf([
        { id: 'u2', telegram_username: 'bob', first_name: 'Bob', last_name: '', role: 'DRIVER', is_active: true, created_at: '2026-10-01T00:00:00Z' },
      ]),
    )
    api.users.update.mockReturnValue(gate.promise)
    renderPage(<UsersPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Bloklash' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Bloklash' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    gate.release({})
    await waitFor(() => expect(api.users.update).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(api.users.update).toHaveBeenCalledTimes(1)
  })

  it('hide review: two synchronous clicks', async () => {
    const gate = hold()
    api.reviews.list.mockResolvedValue(
      pageOf([
        { id: 'rv1', parking_lot: { id: 'l', name: 'Lot A' }, rating: 2, comment: 'x', status: 'PUBLISHED', created_at: '2026-10-01T00:00:00Z' },
      ]),
    )
    api.reviews.hide.mockReturnValue(gate.promise)
    renderPage(<ReviewsPage />)
    const button = await screen.findByRole('button', { name: 'Yashirish' })
    fireEvent.click(button)
    fireEvent.click(button)
    gate.release({})
    await waitFor(() => expect(api.reviews.hide).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(api.reviews.hide).toHaveBeenCalledTimes(1)
  })
})
