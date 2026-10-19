// Typed seed data for the mock API. Shapes follow packages/api-client/src/adminOps.ts and
// docs/ARCHITECTURE.md 9.3.1. Money is always a decimal string.
import type {
  AdminBooking,
  AdminBookingDetail,
  AdminPayment,
  AdminRefund,
  AdminReview,
  AdminSettings,
  AdminUser,
  AuditLogRow,
  AuthUser,
  OccupancyStats,
  OperatorAssignment,
  OperatorInvite,
  ParkingLot,
  RevenueStats,
  StatsOverview,
  UserRole,
} from '@habi/api-client'

/** Deterministic UUID (the admin only links ids that look like UUIDs). The first 8 hex digits
 * are the number, because the tables show only that short id. */
export function uuid(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
}

export const LOT_A = { id: uuid(101), name: 'Chilonzor Parking' }
export const LOT_B = { id: uuid(102), name: 'Yunusobod Garage' }
const ISO = '2026-10-15T14:00:00+05:00'
const ISO_END = '2026-10-15T16:00:00+05:00'

export function meFor(role: UserRole): AuthUser {
  return {
    id: uuid(role === 'ADMIN' ? 1 : role === 'OWNER' ? 2 : 3),
    telegram_id: 777000 + (role === 'ADMIN' ? 1 : 2),
    telegram_username: `e2e_${role.toLowerCase()}`,
    phone: null,
    first_name: `E2E ${role}`,
    last_name: '',
    language: 'en',
    role,
    tg_notifications: true,
  }
}

export function parking(lot: { id: string; name: string }): ParkingLot {
  return {
    id: lot.id,
    owner: uuid(2),
    name: lot.name,
    address: 'Tashkent',
    location: { lat: 41.3, lng: 69.2 },
    area: null,
    status: 'ACTIVE',
    open_time: '00:00:00',
    close_time: '23:59:59',
    total_slots: 40,
    free_slots: 12,
    rating: 4.5,
    created_at: ISO,
  }
}

export function booking(n: number, patch: Partial<AdminBooking> = {}): AdminBooking {
  return {
    id: uuid(1000 + n),
    status: 'CONFIRMED',
    kind: 'ONLINE',
    plate_number: `01A${String(100 + n)}BC`,
    slot: { id: uuid(2000 + n), code: `A-${n}`, zone: 'A', floor: 1, type: 'STANDARD' },
    parking_lot: LOT_A,
    start: ISO,
    end: ISO_END,
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
    created_at: ISO,
    ...patch,
  }
}

export function bookingDetail(base: AdminBooking, state: { payments: AdminPayment[]; refunds: AdminRefund[] }): AdminBookingDetail {
  return {
    ...base,
    events: [
      { id: uuid(3000), created_at: ISO, from_status: '', to_status: 'PENDING_PAYMENT', reason: 'created', actor: null },
    ],
    payments: state.payments.filter((p) => p.booking === base.id),
    refunds: state.refunds.filter((r) => r.booking === base.id),
  }
}

export function user(n: number, patch: Partial<AdminUser> = {}): AdminUser {
  return {
    id: uuid(4000 + n),
    telegram_username: `driver${n}`,
    first_name: `Driver${n}`,
    last_name: 'Test',
    role: 'DRIVER',
    is_active: true,
    created_at: ISO,
    ...patch,
  }
}

export function refund(n: number, patch: Partial<AdminRefund> = {}): AdminRefund {
  return {
    id: uuid(5000 + n),
    payment: uuid(6000 + n),
    booking: uuid(1000 + n),
    amount: '12000.00',
    status: 'MANUAL',
    reason: 'cancel',
    attempts: 3,
    last_error: 'click_error_-9',
    created_at: ISO,
    updated_at: ISO,
    ...patch,
  }
}

export function payment(n: number, patch: Partial<AdminPayment> = {}): AdminPayment {
  return {
    id: uuid(6000 + n),
    booking: uuid(1000 + n),
    provider: 'payme',
    amount: '12000.00',
    refunded_amount: '0.00',
    status: 'PAID',
    performed_at: ISO,
    cancelled_at: null,
    created_at: ISO,
    ...patch,
  }
}

export function review(n: number, patch: Partial<AdminReview> = {}): AdminReview {
  return { id: uuid(7000 + n), parking_lot: LOT_A, rating: 5, comment: 'Great', status: 'PUBLISHED', created_at: ISO, ...patch }
}

export function auditRow(n: number): AuditLogRow {
  return { id: uuid(8000 + n), created_at: ISO, actor: uuid(1), action: 'user.block', target_type: 'user', target_id: uuid(4001), meta: {} }
}

export const OVERVIEW: StatsOverview = {
  bookings_today: 17,
  bookings_active: 5,
  revenue_today: '1250000.00',
  revenue_month: '48500000.00',
  occupancy_percent: '62.50',
  total_slots: 80,
  occupied_slots: 50,
  lots_pending_review: 2,
  refunds_needing_attention: 3,
  overstay_due: 1,
}

export const REVENUE: RevenueStats = {
  results: [
    { date: '2026-10-13', revenue: '800000.00', bookings: 6 },
    { date: '2026-10-14', revenue: '950000.00', bookings: 8 },
    { date: '2026-10-15', revenue: '1250000.00', bookings: 11 },
  ],
}

export const OCCUPANCY: OccupancyStats = {
  results: [
    { parking_lot: LOT_A, total_slots: 40, occupied_slots: 28, occupancy_percent: '70.00' },
    { parking_lot: LOT_B, total_slots: 40, occupied_slots: 22, occupancy_percent: '55.00' },
  ],
}

export const SETTINGS: AdminSettings = {
  hold_minutes: 20,
  no_show_grace_minutes: 15,
  cancel_full_refund_minutes: 120,
  cancel_full_percent: 100,
  cancel_late_percent: 50,
  cancel_after_start_percent: 0,
}

export function operator(n: number): OperatorAssignment {
  return { id: uuid(9000 + n), assignment_id: uuid(9100 + n), display_name: `Operator ${n}`, created_at: ISO }
}

export function invite(n: number): OperatorInvite {
  return { id: uuid(9200 + n), created_at: ISO, expires_at: '2026-10-18T14:00:00+05:00' }
}
