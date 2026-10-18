// Step 11 admin operations: stats, users, bookings, payments/refunds, reviews, settings, audit
// log and operator invitations.
//
// CONTRACT STATUS (see docs/ARCHITECTURE.md 9.3.1): `parkings/{id}/operators` and
// `.../operator-invites` exist in the backend. Every other resource below is the contract the
// admin panel is written against; its backend endpoint was NOT implemented when this was written
// (the panel shows an "endpoint not available" state on 404/405 instead of failing silently).
// Money is always a decimal STRING ("12000.00"); never convert it to a float.
import type { PageParams, Paginated } from './admin'
import type { UserRole } from './auth'
import type { HttpClient } from './http'
import { seg } from './paths'

export type Money = string

export type BookingStatus =
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'ACTIVE'
  | 'OVERSTAY'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'NO_SHOW'
export type BookingKind = 'ONLINE' | 'WALK_IN'
export type OverstayStatus = 'none' | 'due' | 'collected' | 'waived'
export type RefundViewStatus = 'none' | 'pending' | 'done' | 'manual' | 'failed'
export type PaymentProviderName = 'payme' | 'click'
export type PaymentStatus = 'CREATED' | 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDED' | 'FAILED'
export type RefundStatus = 'PENDING' | 'SENT' | 'DONE' | 'FAILED' | 'MANUAL'
export type RefundOutcome = 'done' | 'retry' | 'failed'
export type ReviewStatus = 'PUBLISHED' | 'HIDDEN'

// --- stats -------------------------------------------------------------------------------

export interface StatsParams {
  parking_lot?: string
}

export interface StatsOverview {
  bookings_today: number
  bookings_active: number
  revenue_today: Money
  revenue_month: Money
  /** Percent as a decimal string ("62.50"). */
  occupancy_percent: string
  total_slots: number
  occupied_slots: number
  lots_pending_review: number
  refunds_needing_attention: number
  overstay_due: number
}

export interface RevenuePoint {
  /** Calendar day in Asia/Tashkent, YYYY-MM-DD. */
  date: string
  revenue: Money
  bookings: number
}

export interface RevenueStats {
  results: RevenuePoint[]
}

export interface OccupancyRow {
  parking_lot: { id: string; name: string }
  total_slots: number
  occupied_slots: number
  occupancy_percent: string
}

export interface OccupancyStats {
  results: OccupancyRow[]
}

export interface RevenueParams extends StatsParams {
  from?: string
  to?: string
}

// --- users -------------------------------------------------------------------------------

export interface AdminUser {
  id: string
  telegram_username: string
  first_name: string
  last_name: string
  role: UserRole
  is_active: boolean
  created_at: string
}

export interface UserListParams extends PageParams {
  role?: UserRole
  is_active?: boolean
}

export interface UserUpdate {
  role?: UserRole
  is_active?: boolean
}

// --- bookings ----------------------------------------------------------------------------

export interface AdminBooking {
  id: string
  status: BookingStatus
  kind: BookingKind
  plate_number: string
  slot: { id: string; code: string; zone: string; floor: number; type: string }
  parking_lot: { id: string; name: string }
  start: string
  end: string
  amount: Money
  paid_amount: Money
  refund_amount: Money
  refund_status: RefundViewStatus
  payment_provider: PaymentProviderName | ''
  checked_in_at: string | null
  checked_out_at: string | null
  cancelled_at: string | null
  overstay_minutes: number
  overstay_amount: Money
  overstay_status: OverstayStatus
  overstay_needs_review: boolean
  created_at: string
}

export interface BookingEventRow {
  id: string
  created_at: string
  from_status: string
  to_status: string
  reason: string
  actor: string | null
}

export interface AdminBookingDetail extends AdminBooking {
  events: BookingEventRow[]
  payments: AdminPayment[]
  refunds: AdminRefund[]
}

export interface BookingListParams extends PageParams {
  status?: BookingStatus
  kind?: BookingKind
  parking_lot?: string
  overstay_status?: OverstayStatus
  /** ISO 8601 with offset; start of the period filter (inclusive). */
  from?: string
  to?: string
}

export interface BookingCancelInput {
  reason?: string
}

// --- payments and refunds ----------------------------------------------------------------

export interface AdminPayment {
  id: string
  booking: string
  provider: PaymentProviderName
  amount: Money
  refunded_amount: Money
  status: PaymentStatus
  performed_at: string | null
  cancelled_at: string | null
  created_at: string
}

export interface PaymentListParams extends PageParams {
  status?: PaymentStatus
  provider?: PaymentProviderName
  booking?: string
  from?: string
  to?: string
}

export interface AdminRefund {
  id: string
  payment: string | null
  booking: string
  amount: Money
  status: RefundStatus
  /** Machine code (e.g. cancel, unpaid_booking, duplicate), not free text. */
  reason: string
  attempts: number
  /** Machine code only (never provider text). */
  last_error: string
  created_at: string
  updated_at: string
}

export interface RefundListParams extends PageParams {
  status?: RefundStatus
  /** Only MANUAL and FAILED refunds a person must handle. */
  needs_attention?: boolean
  booking?: string
}

export interface RefundResolveInput {
  outcome: RefundOutcome
  /** <= 200 characters, no phone or card number (the server rejects those). */
  note: string
}

// --- reviews -----------------------------------------------------------------------------

export interface AdminReview {
  id: string
  parking_lot: { id: string; name: string }
  rating: number
  comment: string
  status: ReviewStatus
  created_at: string
}

export interface ReviewListParams extends PageParams {
  status?: ReviewStatus
  parking_lot?: string
  rating?: number
}

// --- settings and audit ------------------------------------------------------------------

export interface AdminSettings {
  hold_minutes: number
  no_show_grace_minutes: number
  cancel_full_refund_minutes: number
  cancel_full_percent: number
  cancel_late_percent: number
  cancel_after_start_percent: number
}

export interface AuditLogRow {
  id: string
  created_at: string
  /** User id; null = the system (Celery) or a deleted account. */
  actor: string | null
  action: string
  target_type: string
  target_id: string
  /** {before, after} already scrubbed server-side; display as inert text only. */
  meta: Record<string, unknown>
}

export interface AuditLogParams extends PageParams {
  action?: string
  actor?: string
  target_type?: string
  target_id?: string
  from?: string
  to?: string
}

// --- operators and one-time invitation codes ---------------------------------------------

export interface OperatorAssignment {
  /** User id. */
  id: string
  assignment_id: string
  /** "Aziza K." for OWNER requests, null for ADMIN. */
  display_name: string | null
  created_at: string
}

export interface OperatorInvite {
  id: string
  created_at: string
  expires_at: string
}

export interface InviteCreated {
  invite_id: string
  /** Shown ONCE: the server stores only a hash and cannot return it again. */
  code: string
  expires_at: string
}

export interface InviteCreateInput {
  /** 1..168, server default 72. */
  expires_in_hours?: number
}

export function createOpsApi(http: HttpClient) {
  const base = '/admin'
  const lot = (id: string) => `${base}/parkings/${seg(id)}`
  return {
    stats: {
      overview: (params: StatsParams = {}) =>
        http.request<StatsOverview>('GET', `${base}/stats/overview`, { query: { ...params } }),
      revenue: (params: RevenueParams = {}) =>
        http.request<RevenueStats>('GET', `${base}/stats/revenue`, { query: { ...params } }),
      occupancy: (params: StatsParams = {}) =>
        http.request<OccupancyStats>('GET', `${base}/stats/occupancy`, { query: { ...params } }),
    },
    users: {
      list: (params: UserListParams = {}) =>
        http.request<Paginated<AdminUser>>('GET', `${base}/users`, { query: { ...params } }),
      update: (id: string, body: UserUpdate) =>
        http.request<AdminUser>('PATCH', `${base}/users/${seg(id)}`, { body }),
    },
    bookings: {
      list: (params: BookingListParams = {}) =>
        http.request<Paginated<AdminBooking>>('GET', `${base}/bookings`, { query: { ...params } }),
      get: (id: string) => http.request<AdminBookingDetail>('GET', `${base}/bookings/${seg(id)}`),
      cancel: (id: string, body: BookingCancelInput = {}) =>
        http.request<AdminBooking>('POST', `${base}/bookings/${seg(id)}/cancel`, { body }),
    },
    payments: {
      list: (params: PaymentListParams = {}) =>
        http.request<Paginated<AdminPayment>>('GET', `${base}/payments`, { query: { ...params } }),
    },
    refunds: {
      list: (params: RefundListParams = {}) =>
        http.request<Paginated<AdminRefund>>('GET', `${base}/refunds`, { query: { ...params } }),
      resolve: (id: string, body: RefundResolveInput) =>
        http.request<AdminRefund>('POST', `${base}/refunds/${seg(id)}/resolve`, { body }),
    },
    reviews: {
      list: (params: ReviewListParams = {}) =>
        http.request<Paginated<AdminReview>>('GET', `${base}/reviews`, { query: { ...params } }),
      hide: (id: string) => http.request<AdminReview>('POST', `${base}/reviews/${seg(id)}/hide`),
      publish: (id: string) =>
        http.request<AdminReview>('POST', `${base}/reviews/${seg(id)}/publish`),
    },
    settings: {
      get: () => http.request<AdminSettings>('GET', `${base}/settings`),
      update: (body: Partial<AdminSettings>) =>
        http.request<AdminSettings>('PATCH', `${base}/settings`, { body }),
    },
    auditLogs: {
      list: (params: AuditLogParams = {}) =>
        http.request<Paginated<AuditLogRow>>('GET', `${base}/audit-logs`, { query: { ...params } }),
    },
    operators: {
      list: (lotId: string, params: PageParams = {}) =>
        http.request<Paginated<OperatorAssignment>>('GET', `${lot(lotId)}/operators`, {
          query: { ...params },
        }),
      revoke: (lotId: string, assignmentId: string) =>
        http.request<null>('DELETE', `${lot(lotId)}/operators/${seg(assignmentId)}`),
    },
    invites: {
      list: (lotId: string, params: PageParams = {}) =>
        http.request<Paginated<OperatorInvite>>('GET', `${lot(lotId)}/operator-invites`, {
          query: { ...params },
        }),
      create: (lotId: string, body: InviteCreateInput = {}) =>
        http.request<InviteCreated>('POST', `${lot(lotId)}/operator-invites`, { body }),
      revoke: (lotId: string, inviteId: string) =>
        http.request<null>('DELETE', `${lot(lotId)}/operator-invites/${seg(inviteId)}`),
    },
  }
}
