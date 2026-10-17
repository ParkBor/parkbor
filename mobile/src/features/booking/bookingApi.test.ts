import { describe, expect, it, vi } from 'vitest';

import { createBookingApi } from '@/features/booking/bookingApi';
import { BOOKING_ID, LOT_ID, rawAvailability, rawBooking, rawPage, rawPrice, VEHICLE_ID } from '@/features/booking/fixtures';
import type { CreateBookingPayload } from '@/features/booking/idempotencyKey';
import { ContractError } from '@/lib/contract';

// Importing the module pulls in the real auth client; replace it (vi.mock is hoisted).
vi.mock('@/lib/api', () => ({ api: {} }));

const START = Date.UTC(2026, 9, 15, 9, 0, 0);
const payload: CreateBookingPayload = {
  parkingLotId: LOT_ID,
  slotType: 'STANDARD',
  vehicleId: VEHICLE_ID,
  startMs: START,
  endMs: START + 2 * 3_600_000,
  preferredSlotId: null,
  paymentProvider: null,
};

function clientWith(response: Partial<{ data: unknown; status: number; headers: Record<string, string> }>) {
  const reply = { data: undefined, status: 200, headers: {}, ...response };
  return {
    get: vi.fn().mockResolvedValue(reply),
    post: vi.fn().mockResolvedValue(reply),
  };
}

describe('create', () => {
  it('POSTs the contract body with the Idempotency-Key header (UTC "Z" instants)', async () => {
    const client = clientWith({ data: rawBooking(), status: 201 });
    const result = await createBookingApi(client, vi.fn()).create(payload, 'key-12345678');
    expect(client.post).toHaveBeenCalledWith(
      '/bookings',
      {
        parking_lot_id: LOT_ID,
        slot_type: 'STANDARD',
        vehicle_id: VEHICLE_ID,
        start: '2026-10-15T09:00:00Z',
        end: '2026-10-15T11:00:00Z',
        preferred_slot_id: null,
      },
      { headers: { 'Idempotency-Key': 'key-12345678' }, signal: undefined },
    );
    expect(result.booking.id).toBe(BOOKING_ID);
    expect(result.isReplay).toBe(false);
  });

  it('sends payment_provider only when the user chose one', async () => {
    const client = clientWith({ data: rawBooking(), status: 201 });
    await createBookingApi(client, vi.fn()).create({ ...payload, paymentProvider: 'click' }, 'key-12345678');
    const body = client.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.payment_provider).toBe('click');
    await createBookingApi(client, vi.fn()).create(payload, 'key-12345678');
    const defaultBody = client.post.mock.calls[1]?.[1] as Record<string, unknown>;
    expect('payment_provider' in defaultBody).toBe(false);
  });

  it('flags a replay (200 + Idempotent-Replayed)', async () => {
    const client = clientWith({ data: rawBooking(), status: 200, headers: { 'idempotent-replayed': 'true' } });
    expect((await createBookingApi(client, vi.fn()).create(payload, 'key-12345678')).isReplay).toBe(true);
  });

  it('refuses a malformed key before any request is made', async () => {
    const client = clientWith({ data: rawBooking(), status: 201 });
    await expect(createBookingApi(client, vi.fn()).create(payload, 'bad key')).rejects.toBeInstanceOf(RangeError);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('refuses a malformed lot or vehicle id', async () => {
    const client = clientWith({ data: rawBooking(), status: 201 });
    await expect(createBookingApi(client, vi.fn()).create({ ...payload, parkingLotId: 'x' }, 'key-12345678')).rejects.toBeInstanceOf(ContractError);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects a body that breaks the contract', async () => {
    const client = clientWith({ data: { id: 'x' }, status: 201 });
    await expect(createBookingApi(client, vi.fn()).create(payload, 'key-12345678')).rejects.toBeInstanceOf(ContractError);
  });

  it('feeds the server Date header to the clock observer', async () => {
    const observe = vi.fn();
    const client = clientWith({ data: rawBooking(), status: 201, headers: { date: 'Thu, 15 Oct 2026 09:00:00 GMT' } });
    await createBookingApi(client, observe).create(payload, 'key-12345678');
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ dateHeader: 'Thu, 15 Oct 2026 09:00:00 GMT', sentAtMs: expect.any(Number), receivedAtMs: expect.any(Number) }),
    );
  });
});

describe('list', () => {
  it('sends scope and paging (and status when given)', async () => {
    const client = clientWith({ data: rawPage([rawBooking()]) });
    const page = await createBookingApi(client, vi.fn()).list({ scope: 'upcoming', page: 2, pageSize: 20 });
    expect(client.get).toHaveBeenCalledWith('/bookings', expect.objectContaining({
      params: { scope: 'upcoming', page: 2, page_size: 20 },
    }));
    expect(page.results).toHaveLength(1);
  });

  it('adds a comma separated status filter', async () => {
    const client = clientWith({ data: rawPage([]) });
    await createBookingApi(client, vi.fn()).list({ status: ['CONFIRMED', 'ACTIVE'], page: 1, pageSize: 10 });
    expect(client.get).toHaveBeenCalledWith('/bookings', expect.objectContaining({
      params: { status: 'CONFIRMED,ACTIVE', page: 1, page_size: 10 },
    }));
  });
});

describe('detail endpoints', () => {
  it('get / cancel / cancelPreview / qr use the contract paths', async () => {
    const getClient = clientWith({ data: rawBooking() });
    await createBookingApi(getClient, vi.fn()).get(BOOKING_ID);
    expect(getClient.get).toHaveBeenCalledWith(`/bookings/${BOOKING_ID}`, expect.anything());

    const cancelClient = clientWith({ data: rawBooking({ status: 'CANCELLED' }) });
    expect((await createBookingApi(cancelClient, vi.fn()).cancel(BOOKING_ID)).status).toBe('CANCELLED');
    expect(cancelClient.post).toHaveBeenCalledWith(`/bookings/${BOOKING_ID}/cancel`, undefined, expect.anything());

    const previewClient = clientWith({ data: { can_cancel: true, refund_percent: 100, refund_amount: '1.00' } });
    expect((await createBookingApi(previewClient, vi.fn()).cancelPreview(BOOKING_ID)).refundPercent).toBe(100);
    expect(previewClient.get).toHaveBeenCalledWith(`/bookings/${BOOKING_ID}/cancel-preview`, expect.anything());

    const qrClient = clientWith({ data: { qr_token: 'tok', expires_at: '2026-10-15T18:00:00+05:00' } });
    expect((await createBookingApi(qrClient, vi.fn()).qr(BOOKING_ID)).token).toBe('tok');
    expect(qrClient.get).toHaveBeenCalledWith(`/bookings/${BOOKING_ID}/qr`, expect.anything());
  });

  it('refuses ids that are not UUIDs (no path injection)', async () => {
    const client = clientWith({ data: rawBooking() });
    const api = createBookingApi(client, vi.fn());
    for (const id of ['../me', `${BOOKING_ID}/cancel`, '', '1; drop']) {
      await expect(api.get(id), id).rejects.toBeInstanceOf(ContractError);
    }
    expect(client.get).not.toHaveBeenCalled();
  });

  it('forwards the abort signal', async () => {
    const client = clientWith({ data: rawBooking() });
    const controller = new AbortController();
    await createBookingApi(client, vi.fn()).get(BOOKING_ID, controller.signal);
    expect(client.get).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
  });
});

describe('quotes', () => {
  const period = { startMs: START, endMs: START + 3_600_000, slotType: 'EV' as const };

  it('availability uses from/to with a safe serializer', async () => {
    const client = clientWith({ data: rawAvailability() });
    await createBookingApi(client, vi.fn()).availability(LOT_ID, period);
    const [path, config] = client.get.mock.calls[0] as [string, { params: Record<string, unknown>; paramsSerializer: (p: Record<string, unknown>) => string }];
    expect(path).toBe(`/parkings/${LOT_ID}/availability`);
    expect(config.params).toEqual({ from: '2026-10-15T09:00:00Z', to: '2026-10-15T10:00:00Z', slot_type: 'EV' });
    expect(config.paramsSerializer(config.params)).toBe('from=2026-10-15T09%3A00%3A00Z&to=2026-10-15T10%3A00%3A00Z&slot_type=EV');
  });

  it('availability without a slot type omits the parameter', async () => {
    const client = clientWith({ data: rawAvailability({ slot_type: null }) });
    await createBookingApi(client, vi.fn()).availability(LOT_ID, { startMs: START, endMs: START + 3_600_000, slotType: null });
    const [, config] = client.get.mock.calls[0] as [string, { params: Record<string, unknown> }];
    expect(config.params).toEqual({ from: '2026-10-15T09:00:00Z', to: '2026-10-15T10:00:00Z' });
  });

  it('price requires a slot type and parses the response', async () => {
    const client = clientWith({ data: rawPrice() });
    const price = await createBookingApi(client, vi.fn()).price(LOT_ID, period);
    expect(client.get).toHaveBeenCalledWith(`/parkings/${LOT_ID}/price`, expect.objectContaining({
      params: { from: '2026-10-15T09:00:00Z', to: '2026-10-15T10:00:00Z', slot_type: 'EV' },
    }));
    expect(price.total).toBe('15750.00');
  });

  it('refuses a malformed lot id', async () => {
    const client = clientWith({ data: rawPrice() });
    await expect(createBookingApi(client, vi.fn()).price('nope', period)).rejects.toBeInstanceOf(ContractError);
  });
});
