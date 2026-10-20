import { ApiError } from '@habi/api-client'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  parkings: { list: vi.fn(), get: vi.fn(), update: vi.fn(), create: vi.fn() },
  users: { list: vi.fn(), update: vi.fn() },
  settings: { get: vi.fn(), update: vi.fn() },
  bookings: { list: vi.fn(), get: vi.fn() },
  refunds: { list: vi.fn(), resolve: vi.fn() },
  payments: { list: vi.fn() },
  auditLogs: { list: vi.fn() },
}))
vi.mock('../components/MapPicker', () => ({ MapPicker: () => null }))
vi.mock('../lib/api', () => ({ adminApi: api, setAccessToken: vi.fn() }))

import { pageOf, renderPage } from '../test/renderPage'
import AuditLogPage from './AuditLogPage'
import BookingDetailPage from './BookingDetailPage'
import BookingsPage from './BookingsPage'
import PaymentsPage from './PaymentsPage'
import RefundsPage from './RefundsPage'
import SettingsPage from './SettingsPage'
import ParkingEditPage from './ParkingEditPage'
import UsersPage from './UsersPage'

const settings = {
  hold_minutes: 10,
  no_show_grace_minutes: 20,
  cancel_full_refund_minutes: 60,
  cancel_full_percent: 100,
  cancel_late_percent: 50,
  cancel_after_start_percent: 0,
}
const BOOKING_ID = '123e4567-e89b-12d3-a456-426614174000'

beforeEach(() => {
  vi.clearAllMocks()
  api.parkings.list.mockResolvedValue(pageOf([]))
})

describe('SettingsPage for a non-superuser', () => {
  it('shows the values read-only with a notice and no save button', async () => {
    api.settings.get.mockResolvedValue(settings)
    renderPage(<SettingsPage />, { superuser: false })
    expect(await screen.findByText(/faqat super admin o‘zgartira oladi/)).toBeInTheDocument()
    const hold = await screen.findByLabelText('To‘lov kutish vaqti (daqiqa)')
    await waitFor(() => expect(hold).toHaveValue('10'))
    expect(hold).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Saqlash' })).toBeNull()
  })

  it.each([
    ['settings_range_invalid', /oraliqdan tashqarida/],
    ['settings_order_invalid', /Foizlar tartibi noto‘g‘ri/],
  ])('maps the server code %s to a translated message', async (code, text) => {
    api.settings.get.mockResolvedValue(settings)
    api.settings.update.mockRejectedValue(new ApiError(400, { detail: 'English', code }, 'http'))
    renderPage(<SettingsPage />)
    const hold = await screen.findByLabelText('To‘lov kutish vaqti (daqiqa)')
    await waitFor(() => expect(hold).toHaveValue('10'))
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByText('English')).toBeNull()
  })

  it('refuses hold times under 5 minutes before calling the server', async () => {
    api.settings.get.mockResolvedValue(settings)
    renderPage(<SettingsPage />)
    const hold = await screen.findByLabelText('To‘lov kutish vaqti (daqiqa)')
    await waitFor(() => expect(hold).toHaveValue('10'))
    await userEvent.clear(hold)
    await userEvent.type(hold, '4')
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    expect(await screen.findByText('Qiymat ruxsat etilgan oraliqdan tashqarida')).toBeInTheDocument()
    expect(api.settings.update).not.toHaveBeenCalled()
  })
})

describe('UsersPage for a non-superuser ADMIN', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'u2',
    telegram_username: 'bob',
    first_name: 'Bob',
    last_name: '',
    role: 'DRIVER',
    is_active: true,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  })

  it('offers no ADMIN role and no block control on ADMIN rows', async () => {
    api.users.list.mockResolvedValue(
      pageOf([row({}), row({ id: 'u3', first_name: 'Eve', role: 'ADMIN' })]),
    )
    renderPage(<UsersPage />, { superuser: false })
    await screen.findByText('Eve')
    // only Bob (a DRIVER) can be blocked
    expect(screen.getAllByRole('button', { name: 'Bloklash' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('combobox', { name: 'Rol Bob' }))
    const options = await screen.findAllByRole('option')
    expect(options.map((o) => o.textContent)).not.toContain('Super admin')
  })

  it('shows the ADMIN controls to a superuser', async () => {
    api.users.list.mockResolvedValue(pageOf([row({ id: 'u3', first_name: 'Eve', role: 'ADMIN' })]))
    renderPage(<UsersPage />, { superuser: true })
    await screen.findByText('Eve')
    expect(screen.getByRole('button', { name: 'Bloklash' })).toBeInTheDocument()
  })
})

describe('server value labels', () => {
  it('shows the booking event actor as a translated role label, never an id', async () => {
    api.bookings.get.mockResolvedValue({
      id: BOOKING_ID,
      status: 'COMPLETED',
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
      events: [
        { id: 'e1', created_at: '2026-10-17T09:00:00Z', from_status: '', to_status: 'ACTIVE', reason: 'a', actor: 'operator' },
        { id: 'e2', created_at: '2026-10-17T09:01:00Z', from_status: 'ACTIVE', to_status: 'COMPLETED', reason: 'b', actor: null },
      ],
      payments: [],
      refunds: [],
    })
    renderPage(<BookingDetailPage />, { path: `/bookings/${BOOKING_ID}`, route: '/bookings/:id' })
    expect(await screen.findByText('Operator')).toBeInTheDocument()
    expect(screen.getAllByText('Tizim').length).toBeGreaterThan(0)
  })

  it('translates the generic refund error an OWNER receives and the codes an ADMIN receives', async () => {
    const base = {
      payment: 'p',
      booking: BOOKING_ID,
      amount: '1.00',
      status: 'FAILED',
      reason: 'cancel',
      attempts: 1,
      created_at: '2026-10-17T10:00:00Z',
      updated_at: '2026-10-17T10:00:00Z',
    }
    api.refunds.list.mockResolvedValue(
      pageOf([
        { ...base, id: 'a', status: 'MANUAL', last_error: 'error' },
        { ...base, id: 'b', last_error: 'unknown_error' },
        { ...base, id: 'c', last_error: 'retries_exhausted' },
      ]),
    )
    renderPage(<RefundsPage />, { role: 'OWNER' })
    // two FAILED status tags + the translated generic error of the first row
    expect(await screen.findAllByText('Xato')).toHaveLength(3)
    expect(screen.getByText('Noma’lum xato')).toBeInTheDocument()
    expect(screen.getByText('Urinishlar tugadi')).toBeInTheDocument()
  })
})

describe('period filter labels', () => {
  it('labels the bookings period by start date and payments / audit by creation date', async () => {
    api.bookings.list.mockResolvedValue(pageOf([]))
    api.payments.list.mockResolvedValue(pageOf([]))
    api.auditLogs.list.mockResolvedValue(pageOf([]))
    const first = renderPage(<BookingsPage />)
    expect((await screen.findAllByTitle('Boshlanish sanasi bo‘yicha davr')).length).toBeGreaterThan(0)
    first.unmount()
    const second = renderPage(<PaymentsPage />)
    expect((await screen.findAllByTitle('Yaratilgan sana bo‘yicha davr')).length).toBeGreaterThan(0)
    second.unmount()
    renderPage(<AuditLogPage />)
    expect((await screen.findAllByTitle('Yaratilgan sana bo‘yicha davr')).length).toBeGreaterThan(0)
    expect(within(document.body).queryByTitle('Boshlanish sanasi bo‘yicha davr')).toBeNull()
  })
})

describe('users table id column', () => {
  it('shows a copyable short id with the full id as its title (to hand a lot to another owner)', async () => {
    api.users.list.mockResolvedValue(
      pageOf([
        { id: '123e4567-e89b-12d3-a456-426614174000', telegram_username: 'bob', first_name: 'Bob', last_name: '', role: 'OWNER', is_active: true, created_at: '2026-10-01T00:00:00Z' },
      ]),
    )
    renderPage(<UsersPage />)
    const short = await screen.findByText('123e4567')
    expect(short).toHaveAttribute('title', '123e4567-e89b-12d3-a456-426614174000')
    expect(screen.getByRole('button', { name: /ID ni nusxalash/ })).toBeInTheDocument()
  })
})

describe('parking edit: owner by Telegram id', () => {
  const LOT = '123e4567-e89b-12d3-a456-426614174000'
  const lot = {
    id: LOT, owner: 'u1', owner_telegram_id: 555000111, name: 'Lot', address: 'Addr', location: { lat: 41, lng: 69 },
    area: null, status: 'ACTIVE', open_time: null, close_time: null, total_slots: 0, free_slots: 0, rating: 0, created_at: '',
  }
  const route = '/parkings/:id/edit'

  it('prefills the current owner Telegram id and does not resend it when unchanged', async () => {
    api.parkings.get.mockResolvedValue(lot)
    api.parkings.update.mockResolvedValue(lot)
    renderPage(<ParkingEditPage />, { path: `/parkings/${LOT}/edit`, route })
    expect(await screen.findByDisplayValue('555000111')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    await waitFor(() => expect(api.parkings.update).toHaveBeenCalledTimes(1))
    expect('owner_telegram_id' in api.parkings.update.mock.calls[0][1]).toBe(false)
  })

  it('sends a changed owner as a number (transfer)', async () => {
    api.parkings.get.mockResolvedValue(lot)
    api.parkings.update.mockResolvedValue(lot)
    renderPage(<ParkingEditPage />, { path: `/parkings/${LOT}/edit`, route })
    const owner = await screen.findByLabelText('Egasi (Telegram ID)')
    await userEvent.clear(owner)
    await userEvent.type(owner, '777888999')
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    await waitFor(() => expect(api.parkings.update).toHaveBeenCalledTimes(1))
    expect(api.parkings.update.mock.calls[0][1].owner_telegram_id).toBe(777888999)
  })

  it('shows no owner field to an OWNER', async () => {
    api.parkings.get.mockResolvedValue({ ...lot, owner_telegram_id: undefined })
    renderPage(<ParkingEditPage />, { role: 'OWNER', path: `/parkings/${LOT}/edit`, route })
    await screen.findByDisplayValue('Lot')
    expect(screen.queryByLabelText('Egasi (Telegram ID)')).toBeNull()
  })

  it('creates a lot with the owner as owner_telegram_id', async () => {
    api.parkings.create.mockResolvedValue(lot)
    renderPage(<ParkingEditPage />, { path: '/parkings/new', route: '/parkings/new' })
    await userEvent.type(await screen.findByLabelText('Nomi'), 'New')
    await userEvent.type(screen.getByLabelText('Manzil'), 'Somewhere')
    await userEvent.type(screen.getByLabelText('Kenglik (lat)'), '41.3')
    await userEvent.type(screen.getByLabelText('Uzunlik (lng)'), '69.2')
    await userEvent.type(screen.getByLabelText('Egasi (Telegram ID)'), '123456789')
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    await waitFor(() => expect(api.parkings.create).toHaveBeenCalledTimes(1))
    expect(api.parkings.create.mock.calls[0][0]).toMatchObject({ owner_telegram_id: 123456789 })
    expect('owner' in api.parkings.create.mock.calls[0][0]).toBe(false)
  })
})
