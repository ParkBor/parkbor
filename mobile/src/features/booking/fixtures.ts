// Test fixtures shaped exactly like the backend contract (ARCHITECTURE 9.5).
export const BOOKING_ID = 'e4d0c1de-1111-4222-8333-444455556666';
export const LOT_ID = 'b2f0c1de-1111-4222-8333-444455556666';
export const VEHICLE_ID = 'a91c1de0-1111-4222-8333-444455556666';
export const SLOT_ID = 'd5a0c1de-1111-4222-8333-444455556666';

export function rawBooking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BOOKING_ID,
    status: 'PENDING_PAYMENT',
    slot: { id: SLOT_ID, code: 'A-12', zone: 'A', floor: 1 },
    parking_lot: { id: LOT_ID, name: 'Chorsu Parking', address: 'Chorsu, Toshkent' },
    vehicle: { id: VEHICLE_ID, plate_number: '01A123BC', type: 'CAR' },
    start: '2026-10-15T14:00:00+05:00',
    end: '2026-10-15T16:00:00+05:00',
    amount: '12000.00',
    paid_amount: '0.00',
    refund_amount: '0.00',
    hold_expires_at: '2026-10-15T13:20:00+05:00',
    payment_url: null,
    payment_provider: '',
    refund_status: 'none',
    checked_in_at: null,
    checked_out_at: null,
    cancelled_at: null,
    created_at: '2026-10-15T13:10:00+05:00',
    ...overrides,
  };
}

export function rawPage(results: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { count: results.length, next: null, previous: null, results, ...extra };
}

export function rawAvailability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot_type: 'STANDARD',
    start: '2026-10-15T14:00:00+05:00',
    end: '2026-10-15T16:00:00+05:00',
    total: 20,
    available: 7,
    is_open: true,
    ...overrides,
  };
}

export function rawPrice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot_type: 'STANDARD',
    start: '2026-10-15T14:00:00+05:00',
    end: '2026-10-15T16:00:00+05:00',
    price_per_hour: '6000.00',
    total_minutes: 120,
    free_minutes: 10,
    billed_minutes: 120,
    segments: [
      { start: '2026-10-15T14:00:00+05:00', end: '2026-10-15T15:00:00+05:00', minutes: 60, coefficient: '1.5', amount: '9000.00' },
      { start: '2026-10-15T15:00:00+05:00', end: '2026-10-15T16:00:00+05:00', minutes: 60, coefficient: '1', amount: '6000.00' },
    ],
    subtotal: '15000.00',
    occupancy: '0.9',
    dynamic_factor: '1.05',
    total: '15750.00',
    available_slots: 3,
    ...overrides,
  };
}
