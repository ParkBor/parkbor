// Test fixtures shaped like the Step 9a operator API (ARCHITECTURE 9.2). Not imported by app code.
export const LOT_ID = '3f2b8c1e-5d4a-4e6b-9c7d-1a2b3c4d5e6f';
export const LOT_ID_2 = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const SLOT_ID = '11111111-2222-4333-8444-555555555555';
export const SLOT_ID_2 = '22222222-3333-4444-8555-666666666666';
export const BOOKING_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const BOOKING_ID_2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

export function rawLot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LOT_ID,
    name: 'Chorsu Parking',
    address: 'Chorsu, Toshkent',
    status: 'ACTIVE',
    open_time: null,
    close_time: null,
    total_slots: 40,
    free_slots: 12,
    require_plate_on_checkin: false,
    ...overrides,
  };
}

export function rawLotPage(
  results: unknown[] = [rawLot()],
  next: string | null = null,
): Record<string, unknown> {
  return { count: results.length, next, previous: null, results };
}

export function rawGateBooking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BOOKING_ID,
    status: 'ACTIVE',
    kind: 'ONLINE',
    plate_number: '01A123BC',
    slot: { id: SLOT_ID, code: 'A-12', zone: 'A', floor: 1, type: 'STANDARD' },
    parking_lot: { id: LOT_ID, name: 'Chorsu Parking' },
    start: '2026-10-17T09:00:00+05:00',
    end: '2026-10-17T11:00:00+05:00',
    amount: '12000.00',
    paid_amount: '12000.00',
    checked_in_at: '2026-10-17T09:02:00+05:00',
    checked_out_at: null,
    overstay_minutes: 0,
    overstay_amount: '0.00',
    overstay_status: 'none',
    ...overrides,
  };
}

export function rawCheckIn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowed: true,
    result: 'checked_in',
    booking: rawGateBooking(),
    next: {
      checkout_by: '2026-10-17T11:00:00+05:00',
      overstay: { free_minutes: 0, block_minutes: 15, price_per_block: '1500.00', collected_at_exit: true },
    },
    ...overrides,
  };
}

export function rawCheckOut(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result: 'completed',
    allowed: true,
    booking: rawGateBooking({ status: 'COMPLETED', checked_out_at: '2026-10-17T11:20:00+05:00' }),
    actual_minutes: 138,
    overstay: { minutes: 20, amount: '3000.00', status: 'due', needs_review: false },
    to_collect: '3000.00',
    ...overrides,
  };
}

export function rawWalkIn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result: 'registered',
    booking: rawGateBooking({ kind: 'WALK_IN', amount: '0.00', paid_amount: '0.00' }),
    valid_until: '2026-10-17T21:00:00+05:00',
    ...overrides,
  };
}

export function rawMapBooking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BOOKING_ID,
    status: 'ACTIVE',
    kind: 'ONLINE',
    plate_number: '01A123BC',
    start: '2026-10-17T09:00:00+05:00',
    end: '2026-10-17T11:00:00+05:00',
    ...overrides,
  };
}

export function rawMapSlot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SLOT_ID,
    code: 'A-12',
    zone: 'A',
    floor: 1,
    type: 'STANDARD',
    status: 'FREE',
    current_booking: null,
    next_booking: null,
    ...overrides,
  };
}

export function rawSlotMap(
  slots: unknown[] = [rawMapSlot()],
  truncated = false,
): Record<string, unknown> {
  return { parking_lot: rawLot(), slots, truncated };
}
