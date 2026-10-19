// In-browser mock of the ParkBor API for the admin E2E suite. Installed with page.route(); nothing
// reaches a network. Every test gets its own instance, so tests share no state.
import type { Page, Route } from '@playwright/test'
import type { AdminBooking, AdminRefund, AdminUser, AuthUser, OperatorAssignment, OperatorInvite, UserRole } from '@habi/api-client'
import * as f from './fixtures'

export interface RecordedCall {
  method: string
  /** Path below /api/v1, without the query. */
  path: string
  query: Record<string, string>
  body: unknown
  authorization: string | null
}

export interface MockResponse {
  status?: number
  json?: unknown
  /** Raw body (e.g. an HTML 404 page that is not DRF JSON). */
  text?: string
  contentType?: string
  delayMs?: number
}

export type Responder = (call: RecordedCall) => MockResponse | undefined | Promise<MockResponse | undefined>
interface Override {
  method: string
  path: RegExp
  respond: Responder
}

export const DRF_NOT_FOUND = { detail: 'Not found.', code: 'not_found' }
export const INVITE_CODE = 'E2E-ONCE-CODE-7Q4K'
const PLAIN_404: MockResponse = { status: 404, text: 'Not Found', contentType: 'text/html' }

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class MockApi {
  role: UserRole = 'ADMIN'
  users: AdminUser[] = [f.user(1), f.user(2, { first_name: 'Blocked', is_active: false })]
  bookings: AdminBooking[] = [
    f.booking(1),
    f.booking(2, { status: 'COMPLETED', plate_number: '01B222XY' }),
    f.booking(3, { status: 'CANCELLED', plate_number: '01C333ZZ', cancelled_at: '2026-10-15T15:00:00+05:00' }),
  ]
  payments = [f.payment(1)]
  refunds: AdminRefund[] = [f.refund(1)]
  operators: OperatorAssignment[] = [f.operator(1)]
  invites: OperatorInvite[] = [f.invite(1)]
  readonly calls: RecordedCall[] = []
  private overrides: Override[] = []
  private tokenSeq = 0
  /** True makes every refresh answer 401 token_not_valid (an expired session). */
  refreshRejected = false

  get me(): AuthUser {
    return f.meFor(this.role)
  }

  /** Newest override wins. `respond` may return undefined to fall through to the default. */
  override(method: string, path: RegExp | string, respond: Responder): void {
    const pattern = typeof path === 'string' ? new RegExp(`^${escapeRegExp(path)}$`) : path
    this.overrides.unshift({ method: method.toUpperCase(), path: pattern, respond })
  }

  callsTo(method: string, path: RegExp | string): RecordedCall[] {
    return this.calls.filter(
      (c) => c.method === method.toUpperCase() && (typeof path === 'string' ? c.path === path : path.test(c.path)),
    )
  }

  async install(page: Page): Promise<void> {
    await page.route('**/api/v1/**', (route) => this.handle(route))
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    const raw = request.postData()
    const call: RecordedCall = {
      method: request.method(),
      path: url.pathname.replace(/^\/api\/v1/, '').replace(/\/$/, ''),
      query: Object.fromEntries(url.searchParams),
      body: raw ? (JSON.parse(raw) as unknown) : null,
      authorization: request.headers()['authorization'] ?? null,
    }
    this.calls.push(call)
    let response: MockResponse | undefined
    for (const o of this.overrides) {
      if (o.method === call.method && o.path.test(call.path)) {
        response = await o.respond(call)
        if (response) break
      }
    }
    response ??= this.route(call)
    if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs))
    await route.fulfill({
      status: response.status ?? 200,
      contentType: response.contentType ?? 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: response.text ?? (response.json === undefined ? '' : JSON.stringify(response.json)),
    })
  }

  private paged<T>(items: T[], query: Record<string, string>): MockResponse {
    const size = Number(query.page_size ?? 20)
    const page = Number(query.page ?? 1)
    const results = items.slice((page - 1) * size, page * size)
    return { json: { count: items.length, next: page * size < items.length ? 'more' : null, previous: null, results } }
  }

  private route(c: RecordedCall): MockResponse {
    const { method, path, query } = c
    if (method === 'POST' && path === '/auth/telegram/widget') return { json: { ...this.issuePair(), user: this.me, is_new: false } }
    if (method === 'POST' && path === '/auth/token/refresh') {
      return this.refreshRejected
        ? { status: 401, json: { detail: 'Token is invalid or expired', code: 'token_not_valid' } }
        : { json: this.issuePair() }
    }
    if (method === 'POST' && path === '/auth/logout') return { status: 204 }
    if (method === 'GET' && path === '/me') return { json: this.me }
    const seg = path.split('/').filter(Boolean)
    if (seg[0] !== 'admin') return PLAIN_404
    return this.admin(method, seg.slice(1), query, c.body)
  }

  private issuePair(): { access: string; refresh: string } {
    this.tokenSeq += 1
    return { access: `e2e-access-token-${this.tokenSeq}`, refresh: `e2e-refresh-token-${this.tokenSeq}` }
  }

  private admin(method: string, rest: string[], query: Record<string, string>, body: unknown): MockResponse {
    const [res, id, sub] = rest
    const key = `${method} ${res}`
    if (key === 'GET parkings' && !id) return this.paged([f.parking(f.LOT_A), f.parking(f.LOT_B)], query)
    if (key === 'GET stats') return { json: { overview: f.OVERVIEW, revenue: f.REVENUE, occupancy: f.OCCUPANCY }[id] }
    if (key === 'GET users') return this.paged(this.filterUsers(query), query)
    if (key === 'PATCH users') return this.patchUser(id, body as Partial<AdminUser>)
    if (key === 'GET bookings' && !id) return this.paged(this.filterBookings(query), query)
    if (key === 'GET bookings') return this.bookingById(id)
    if (key === 'POST bookings' && sub === 'cancel') return this.cancelBooking(id)
    if (key === 'GET payments') return this.paged(this.payments, query)
    if (key === 'GET refunds') return this.paged(this.filterRefunds(query), query)
    if (key === 'POST refunds' && sub === 'resolve') return this.resolveRefund(id, body as { outcome: string })
    if (key === 'GET reviews') return this.paged([f.review(1)], query)
    if (key === 'GET settings') return { json: f.SETTINGS }
    if (key === 'GET audit-logs') return this.paged([f.auditRow(1)], query)
    if (res === 'parkings' && sub === 'operators') return method === 'GET' ? this.paged(this.operators, query) : { status: 204 }
    if (res === 'parkings' && sub === 'operator-invites') return this.invite(method, query)
    return PLAIN_404
  }

  private filterUsers(q: Record<string, string>): AdminUser[] {
    return this.users.filter((u) => (!q.role || u.role === q.role) && (!q.is_active || String(u.is_active) === q.is_active))
  }

  private patchUser(id: string, patch: Partial<AdminUser>): MockResponse {
    const found = this.users.find((u) => u.id === id)
    if (!found) return { status: 404, json: DRF_NOT_FOUND }
    const updated = { ...found, ...patch }
    this.users = this.users.map((u) => (u.id === id ? updated : u))
    return { json: updated }
  }

  private filterBookings(q: Record<string, string>): AdminBooking[] {
    const needle = (q.search ?? '').toLowerCase()
    return this.bookings.filter(
      (b) =>
        (!q.status || b.status === q.status) &&
        (!q.kind || b.kind === q.kind) &&
        (!q.parking_lot || b.parking_lot.id === q.parking_lot) &&
        (!needle || b.plate_number.toLowerCase().includes(needle)),
    )
  }

  private bookingById(id: string): MockResponse {
    const found = this.bookings.find((b) => b.id === id)
    return found ? { json: f.bookingDetail(found, this) } : { status: 404, json: DRF_NOT_FOUND }
  }

  private cancelBooking(id: string): MockResponse {
    const found = this.bookings.find((b) => b.id === id)
    if (!found) return { status: 404, json: DRF_NOT_FOUND }
    if (found.status !== 'CONFIRMED' && found.status !== 'PENDING_PAYMENT') {
      return { status: 409, json: { detail: 'Invalid transition', code: 'invalid_transition' } }
    }
    const updated: AdminBooking = { ...found, status: 'CANCELLED', cancelled_at: '2026-10-15T15:00:00+05:00', refund_status: 'pending' }
    this.bookings = this.bookings.map((b) => (b.id === id ? updated : b))
    // Slow enough that a second click on the confirm button lands while the first is in flight.
    return { delayMs: 300, json: updated }
  }

  private filterRefunds(q: Record<string, string>): AdminRefund[] {
    const needsAttention = (r: AdminRefund) => r.status === 'MANUAL' || (r.status === 'FAILED' && r.last_error !== 'operator_failed')
    return this.refunds.filter((r) => (!q.status || r.status === q.status) && (q.needs_attention !== 'true' || needsAttention(r)))
  }

  private resolveRefund(id: string, body: { outcome: string }): MockResponse {
    const found = this.refunds.find((r) => r.id === id)
    if (!found) return { status: 404, json: DRF_NOT_FOUND }
    const status = body.outcome === 'done' ? 'DONE' : body.outcome === 'retry' ? 'PENDING' : 'FAILED'
    const updated: AdminRefund = { ...found, status, last_error: body.outcome === 'failed' ? 'operator_failed' : '' }
    this.refunds = this.refunds.map((r) => (r.id === id ? updated : r))
    return { json: updated }
  }

  private invite(method: string, query: Record<string, string>): MockResponse {
    if (method === 'GET') return this.paged(this.invites, query)
    if (method === 'DELETE') return { status: 204 }
    const created = f.invite(this.invites.length + 2)
    this.invites = [...this.invites, created]
    return { status: 201, json: { invite_id: created.id, code: INVITE_CODE, expires_at: created.expires_at } }
  }
}
