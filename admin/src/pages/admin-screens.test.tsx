import { ApiError } from '@habi/api-client'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  parkings: { list: vi.fn(), approve: vi.fn(), suspend: vi.fn(), restore: vi.fn() },
  users: { list: vi.fn(), update: vi.fn() },
  settings: { get: vi.fn(), update: vi.fn() },
  auditLogs: { list: vi.fn() },
  bookings: { list: vi.fn(), get: vi.fn(), cancel: vi.fn() },
  reviews: { list: vi.fn(), hide: vi.fn(), publish: vi.fn() },
  stats: { overview: vi.fn(), revenue: vi.fn(), occupancy: vi.fn() },
}))
vi.mock('../lib/api', () => ({ adminApi: api, setAccessToken: vi.fn() }))

import { pageOf, renderPage } from '../test/renderPage'
import AuditLogPage from './AuditLogPage'
import BookingDetailPage from './BookingDetailPage'
import BookingsPage from './BookingsPage'
import DashboardPage from './DashboardPage'
import ModerationPage from './ModerationPage'
import OverstayPage from './OverstayPage'
import ReviewsPage from './ReviewsPage'
import SettingsPage from './SettingsPage'
import UsersPage from './UsersPage'

const BOOKING_ID = '123e4567-e89b-12d3-a456-426614174000'
const booking = (over: Record<string, unknown> = {}) => ({
  id: BOOKING_ID,
  status: 'CONFIRMED',
  kind: 'ONLINE',
  plate_number: '01A123BC',
  slot: { id: 's', code: 'A-1', zone: 'A', floor: 1, type: 'STANDARD' },
  parking_lot: { id: 'l', name: 'Lot A' },
  start: '2026-10-17T10:00:00Z',
  end: '2026-10-17T12:00:00Z',
  amount: '12000.00',
  paid_amount: '12000.00',
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
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.parkings.list.mockResolvedValue(pageOf([]))
})

describe('BookingsPage', () => {
  it('shows money as grouped text and Tashkent time, and strips hostile characters', async () => {
    api.bookings.list.mockResolvedValue(pageOf([booking({ plate_number: '01‮A123BC' })]))
    renderPage(<BookingsPage />)
    expect(await screen.findAllByText('12 000')).toHaveLength(2)
    expect(screen.getByText('01A123BC')).toBeInTheDocument()
    expect(screen.getByText(/15:00/)).toBeInTheDocument() // 10:00Z is 15:00 in Tashkent
  })

  it('pages on the server', async () => {
    api.bookings.list.mockResolvedValue(pageOf([booking()], 45))
    renderPage(<BookingsPage />)
    await screen.findByText('Lot A')
    await userEvent.click(screen.getByTitle('2'))
    await waitFor(() =>
      expect(api.bookings.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, page_size: 20 })),
    )
  })

  it('shows an unavailable notice instead of an empty table when the endpoint is missing', async () => {
    api.bookings.list.mockRejectedValue(new ApiError(404, null, 'http'))
    renderPage(<BookingsPage />)
    expect(await screen.findByText(/serverda hali mavjud emas/)).toBeInTheDocument()
  })
})

describe('OverstayPage', () => {
  it('always filters on overstay_status=due', async () => {
    api.bookings.list.mockResolvedValue(
      pageOf([booking({ overstay_status: 'due', overstay_amount: '3000.00', overstay_minutes: 20, overstay_needs_review: true })]),
    )
    renderPage(<OverstayPage />)
    expect(await screen.findByText('Tekshirish kerak')).toBeInTheDocument()
    expect(api.bookings.list).toHaveBeenCalledWith(expect.objectContaining({ overstay_status: 'due' }))
  })
})

describe('BookingDetailPage', () => {
  const route = '/bookings/:id'
  const detail = (over: Record<string, unknown> = {}) => ({
    ...booking(over),
    events: [
      { id: 'e1', created_at: '2026-10-17T09:00:00Z', from_status: '', to_status: 'PENDING_PAYMENT', reason: 'created', actor: null },
    ],
    payments: [],
    refunds: [],
  })

  it('does not call the server for a malformed id', async () => {
    renderPage(<BookingDetailPage />, { path: '/bookings/..%2Fevil', route })
    expect(await screen.findByText('Topilmadi')).toBeInTheDocument()
    expect(api.bookings.get).not.toHaveBeenCalled()
  })

  it('cancels a confirmed booking after confirmation, with the reason', async () => {
    api.bookings.get.mockResolvedValue(detail())
    api.bookings.cancel.mockResolvedValue(booking({ status: 'CANCELLED' }))
    renderPage(<BookingDetailPage />, { path: `/bookings/${BOOKING_ID}`, route })
    await userEvent.click(await screen.findByRole('button', { name: 'Bronni bekor qilish' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Sabab (ixtiyoriy)'), 'haydovchi so‘radi')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ha, bekor qilish' }))
    await waitFor(() => expect(api.bookings.cancel).toHaveBeenCalledWith(BOOKING_ID, { reason: 'haydovchi so‘radi' }))
  })

  it('offers no cancel for a completed booking', async () => {
    api.bookings.get.mockResolvedValue(detail({ status: 'COMPLETED' }))
    renderPage(<BookingDetailPage />, { path: `/bookings/${BOOKING_ID}`, route })
    await screen.findByText('Tarix')
    expect(screen.queryByRole('button', { name: 'Bronni bekor qilish' })).toBeNull()
  })

  it('shows not found for a 404', async () => {
    api.bookings.get.mockRejectedValue(new ApiError(404, { detail: 'Not found.' }, 'http'))
    renderPage(<BookingDetailPage />, { path: `/bookings/${BOOKING_ID}`, route })
    expect(await screen.findByText('Topilmadi')).toBeInTheDocument()
  })
})

describe('UsersPage', () => {
  const user = (over: Record<string, unknown> = {}) => ({
    id: 'u2',
    telegram_username: 'bob',
    first_name: 'Bob',
    last_name: '',
    role: 'DRIVER',
    is_active: true,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  })

  it('blocks a user after confirmation', async () => {
    api.users.list.mockResolvedValue(pageOf([user()]))
    api.users.update.mockResolvedValue(user({ is_active: false }))
    renderPage(<UsersPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Bloklash' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bloklash' }))
    await waitFor(() => expect(api.users.update).toHaveBeenCalledWith('u2', { is_active: false }))
  })

  it('unblocks a blocked user', async () => {
    api.users.list.mockResolvedValue(pageOf([user({ is_active: false })]))
    api.users.update.mockResolvedValue(user())
    renderPage(<UsersPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Blokdan chiqarish' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Blokdan chiqarish' }))
    await waitFor(() => expect(api.users.update).toHaveBeenCalledWith('u2', { is_active: true }))
  })

  it('gives no block or role controls for the signed-in admin themself', async () => {
    api.users.list.mockResolvedValue(pageOf([user({ id: 'u1', first_name: 'Ali', role: 'ADMIN' })]))
    renderPage(<UsersPage />)
    expect(await screen.findByText('Ali')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Bloklash' })).toBeNull()
  })

  it('searches by username or name only (the server has no phone search)', async () => {
    api.users.list.mockResolvedValue(pageOf([user()]))
    renderPage(<UsersPage />)
    await screen.findByText('Bob')
    const box = screen.getByLabelText('Username, ism yoki familiya bo‘yicha qidirish')
    await userEvent.type(box, '@bob{enter}')
    await waitFor(() =>
      expect(api.users.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: '@bob', page: 1 })),
    )
  })

  it.each([
    ['cannot_modify_self', 403, 'O‘zingizni o‘zgartirib bo‘lmaydi.'],
    ['super_admin_protected', 403, 'Super admin akkauntini o‘zgartirib bo‘lmaydi.'],
    ['super_admin_required', 403, /faqat super admin uchun/],
    ['last_admin', 409, /oxirgi faol admin/],
    ['owner_has_parkings', 409, /avtoturargohlari bor/],
  ])('explains the server refusal %s in the UI language', async (code, status, text) => {
    api.users.list.mockResolvedValue(pageOf([user()]))
    api.users.update.mockRejectedValue(new ApiError(status, { detail: 'English', code }, 'http'))
    renderPage(<UsersPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Bloklash' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bloklash' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByText('English')).toBeNull()
  })

  it('keeps the list unchanged when the server refuses', async () => {
    api.users.list.mockResolvedValue(pageOf([user()]))
    api.users.update.mockRejectedValue(new ApiError(403, { detail: 'nope' }, 'http'))
    renderPage(<UsersPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Bloklash' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bloklash' }))
    await waitFor(() => expect(api.users.update).toHaveBeenCalled())
    expect(await screen.findByText('Xatolik yuz berdi')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
  })
})

describe('ModerationPage', () => {
  it('approves a pending lot after confirmation', async () => {
    api.parkings.list.mockResolvedValue(
      pageOf([
        { id: 'l1', owner: 'o', name: 'New lot', address: 'x', location: { lat: 1, lng: 1 }, area: null, status: 'PENDING_REVIEW', open_time: null, close_time: null, total_slots: 5, free_slots: 5, rating: 0, created_at: '' },
      ]),
    )
    api.parkings.approve.mockResolvedValue({})
    renderPage(<ModerationPage />)
    expect(api.parkings.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'PENDING_REVIEW' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Tasdiqlash' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tasdiqlash' }))
    await waitFor(() => expect(api.parkings.approve).toHaveBeenCalledWith('l1'))
  })
})

describe('ReviewsPage', () => {
  const review = (over: Record<string, unknown> = {}) => ({
    id: 'rv1',
    parking_lot: { id: 'l', name: 'Lot A' },
    rating: 2,
    comment: '<img src=x onerror=alert(1)> bad',
    status: 'PUBLISHED',
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  })

  it('renders review text inertly and lets ADMIN hide it', async () => {
    api.reviews.list.mockResolvedValue(pageOf([review()]))
    api.reviews.hide.mockResolvedValue(review({ status: 'HIDDEN' }))
    const { container } = renderPage(<ReviewsPage />)
    expect(await screen.findByText(/<img src=x/)).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Yashirish' }))
    await waitFor(() => expect(api.reviews.hide).toHaveBeenCalledWith('rv1'))
  })

  it('is read-only for an OWNER', async () => {
    api.reviews.list.mockResolvedValue(pageOf([review()]))
    renderPage(<ReviewsPage />, { role: 'OWNER' })
    await screen.findByText(/<img src=x/)
    expect(screen.queryByRole('button', { name: 'Yashirish' })).toBeNull()
  })
})

describe('SettingsPage', () => {
  const settings = {
    hold_minutes: 10,
    no_show_grace_minutes: 20,
    cancel_full_refund_minutes: 60,
    cancel_full_percent: 100,
    cancel_late_percent: 50,
    cancel_after_start_percent: 0,
  }

  it('loads the values and saves valid changes', async () => {
    api.settings.get.mockResolvedValue(settings)
    api.settings.update.mockResolvedValue({ ...settings, hold_minutes: 15 })
    renderPage(<SettingsPage />)
    const hold = await screen.findByLabelText('To‘lov kutish vaqti (daqiqa)')
    await waitFor(() => expect(hold).toHaveValue('10'))
    await userEvent.clear(hold)
    await userEvent.type(hold, '15')
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    await waitFor(() => expect(api.settings.update).toHaveBeenCalledWith({ ...settings, hold_minutes: 15 }))
  })

  it('shows the ordering rule after_start <= late <= full without calling the server', async () => {
    api.settings.get.mockResolvedValue(settings)
    renderPage(<SettingsPage />)
    const late = await screen.findByLabelText('Kech bekor qilishda qaytarish (%)')
    await waitFor(() => expect(late).toHaveValue('50'))
    const after = screen.getByLabelText('Boshlangandan keyin qaytarish (%)')
    await userEvent.clear(after)
    await userEvent.type(after, '80')
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    expect(await screen.findByText(/Tartib: boshlangandan keyin/)).toBeInTheDocument()
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('does not send a percentage above 100', async () => {
    api.settings.get.mockResolvedValue(settings)
    renderPage(<SettingsPage />)
    const late = await screen.findByLabelText('Kech bekor qilishda qaytarish (%)')
    await waitFor(() => expect(late).toHaveValue('50'))
    await userEvent.clear(late)
    await userEvent.type(late, '150')
    await userEvent.click(screen.getByRole('button', { name: 'Saqlash' }))
    expect(await screen.findByText('Foiz 0 dan 100 gacha bo‘lsin')).toBeInTheDocument()
    expect(api.settings.update).not.toHaveBeenCalled()
  })
})

describe('AuditLogPage', () => {
  const row = {
    id: 'a1',
    created_at: '2026-10-17T10:00:00Z',
    actor: '123e4567-e89b-12d3-a456-426614174000',
    action: 'refund.resolve',
    target_type: 'refund',
    target_id: 'r1',
    meta: { after: { note: '<script>alert(1)</script>' } },
  }

  it('is read-only and prints meta as inert text', async () => {
    api.auditLogs.list.mockResolvedValue(pageOf([row]))
    const { container } = renderPage(<AuditLogPage />)
    expect(await screen.findByText('refund.resolve')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /expand row/i }))
    expect(await screen.findByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Saqlash' })).toBeNull()
  })

  it('does not send a malformed actor id', async () => {
    api.auditLogs.list.mockResolvedValue(pageOf([row]))
    renderPage(<AuditLogPage />)
    await screen.findByText('refund.resolve')
    await userEvent.type(screen.getByLabelText('Foydalanuvchi ID (UUID)'), 'not-a-uuid')
    expect(await screen.findByText('To‘g‘ri ID (UUID) kiriting')).toBeInTheDocument()
    for (const call of api.auditLogs.list.mock.calls) expect(call[0].actor).toBeUndefined()
  })
})

describe('DashboardPage', () => {
  it('shows counts, money strings and occupancy from the stats endpoints', async () => {
    api.stats.overview.mockResolvedValue({
      bookings_today: 7,
      bookings_active: 3,
      revenue_today: '1234567.50',
      revenue_month: '9007199254740993.01',
      occupancy_percent: '62.50',
      total_slots: 40,
      occupied_slots: 25,
      lots_pending_review: 2,
      refunds_needing_attention: 1,
      overstay_due: 4,
    })
    api.stats.revenue.mockResolvedValue({ results: [{ date: '2026-10-17', revenue: '1000.00', bookings: 2 }] })
    api.stats.occupancy.mockResolvedValue({
      results: [{ parking_lot: { id: 'l', name: 'Lot A' }, total_slots: 40, occupied_slots: 25, occupancy_percent: '62.50' }],
    })
    renderPage(<DashboardPage />)
    expect(await screen.findByText('1 234 567.50')).toBeInTheDocument()
    expect(screen.getByText('9 007 199 254 740 993.01')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
    expect(screen.getAllByText('62.50%').length).toBeGreaterThan(0)
    expect(screen.getByText('Lot A')).toBeInTheDocument()
    expect(screen.getByText(/Tasdiq kutayotgan avtoturargohlar: 2/)).toBeInTheDocument()
  })

  it('hides the moderation shortcut from an OWNER', async () => {
    api.stats.overview.mockResolvedValue({
      bookings_today: 0, bookings_active: 0, revenue_today: '0.00', revenue_month: '0.00',
      occupancy_percent: '0', total_slots: 0, occupied_slots: 0, lots_pending_review: 0,
      refunds_needing_attention: 0, overstay_due: 0,
    })
    api.stats.revenue.mockResolvedValue({ results: [] })
    api.stats.occupancy.mockResolvedValue({ results: [] })
    renderPage(<DashboardPage />, { role: 'OWNER' })
    await screen.findByText('Bugungi bronlar')
    expect(screen.queryByText(/Tasdiq kutayotgan/)).toBeNull()
  })

  it('reports a missing stats endpoint', async () => {
    api.stats.overview.mockRejectedValue(new ApiError(404, null, 'http'))
    api.stats.revenue.mockRejectedValue(new ApiError(404, null, 'http'))
    api.stats.occupancy.mockRejectedValue(new ApiError(404, null, 'http'))
    renderPage(<DashboardPage />)
    expect((await screen.findAllByText(/serverda hali mavjud emas/)).length).toBeGreaterThan(0)
  })
})
