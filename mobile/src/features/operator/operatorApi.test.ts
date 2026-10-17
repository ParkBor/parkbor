import { describe, expect, it, vi } from 'vitest';

import {
  BOOKING_ID,
  LOT_ID,
  LOT_ID_2,
  rawCheckIn,
  rawCheckOut,
  rawLot,
  rawLotPage,
  rawSlotMap,
  rawWalkIn,
  SLOT_ID,
} from '@/features/operator/fixtures';
import { createOperatorApi } from '@/features/operator/operatorApi';
import { ContractError } from '@/lib/contract';

// Importing the module pulls in the real auth client; replace it (vi.mock is hoisted).
vi.mock('@/lib/api', () => ({ api: {} }));

const TOKEN = 'abcDEF123-_:xyz'.padEnd(40, 'k');

function clientWith(data: unknown, status = 200) {
  const reply = { data, status, headers: {} };
  return {
    get: vi.fn().mockResolvedValue(reply),
    post: vi.fn().mockResolvedValue(reply),
    patch: vi.fn().mockResolvedValue(reply),
  };
}

describe('lots', () => {
  it('reads every page by number and never follows the server "next" URL', async () => {
    const client = clientWith(null);
    client.get
      .mockResolvedValueOnce({ data: rawLotPage([rawLot()], 'http://evil.example/?page=2'), status: 200, headers: {} })
      .mockResolvedValueOnce({ data: rawLotPage([rawLot({ id: LOT_ID_2 })]), status: 200, headers: {} });
    const lots = await createOperatorApi(client).lots();
    expect(lots.map((l) => l.id)).toEqual([LOT_ID, LOT_ID_2]);
    expect(client.get).toHaveBeenNthCalledWith(1, '/operator/parkings', expect.objectContaining({ params: { page: 1, page_size: 50 } }));
    expect(client.get).toHaveBeenNthCalledWith(2, '/operator/parkings', expect.objectContaining({ params: { page: 2, page_size: 50 } }));
  });

  it('stops at a sane page limit', async () => {
    const client = clientWith(rawLotPage([rawLot()], 'next'));
    await createOperatorApi(client).lots();
    expect(client.get.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe('slots', () => {
  it('one request per map, id checked before it enters the path', async () => {
    const client = clientWith(rawSlotMap());
    const map = await createOperatorApi(client).slots(LOT_ID);
    expect(map.slots).toHaveLength(1);
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get.mock.calls[0]?.[0]).toBe(`/operator/parkings/${LOT_ID}/slots`);
    await expect(createOperatorApi(client).slots('../admin')).rejects.toBeInstanceOf(ContractError);
  });
});

describe('checkIn', () => {
  it('always sends the lot id; the plate only when given', async () => {
    const client = clientWith(rawCheckIn());
    const api = createOperatorApi(client);
    await api.checkIn({ token: TOKEN, lotId: LOT_ID, plate: null });
    expect(client.post).toHaveBeenCalledWith('/operator/checkin', { qr_token: TOKEN, parking_lot_id: LOT_ID }, expect.anything());
    await api.checkIn({ token: TOKEN, lotId: LOT_ID, plate: '01A123BC' });
    expect(client.post).toHaveBeenLastCalledWith('/operator/checkin', { qr_token: TOKEN, parking_lot_id: LOT_ID, plate_number: '01A123BC' }, expect.anything());
  });

  it('refuses an over-long token and a bad lot id without a request', async () => {
    const client = clientWith(rawCheckIn());
    const api = createOperatorApi(client);
    await expect(api.checkIn({ token: 'a'.repeat(1025), lotId: LOT_ID, plate: null })).rejects.toBeInstanceOf(RangeError);
    await expect(api.checkIn({ token: TOKEN, lotId: 'nope', plate: null })).rejects.toBeInstanceOf(ContractError);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('a broken answer is a ContractError that carries no content', async () => {
    const api = createOperatorApi(clientWith({ allowed: 'x', secret: TOKEN }));
    const error = await api.checkIn({ token: TOKEN, lotId: LOT_ID, plate: null }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});

describe('checkOut', () => {
  it('QR exit: token, lot, collect flag, optional plate', async () => {
    const client = clientWith(rawCheckOut());
    const api = createOperatorApi(client);
    await api.checkOut({ target: { kind: 'qr', token: TOKEN }, lotId: LOT_ID, collect: false });
    expect(client.post).toHaveBeenCalledWith('/operator/checkout', { qr_token: TOKEN, parking_lot_id: LOT_ID, collect: false }, expect.anything());
    await api.checkOut({ target: { kind: 'qr', token: TOKEN, plate: '01A123BC' }, lotId: LOT_ID, collect: true });
    expect(client.post).toHaveBeenLastCalledWith('/operator/checkout', { qr_token: TOKEN, parking_lot_id: LOT_ID, collect: true, plate_number: '01A123BC' }, expect.anything());
  });

  it('manual exit: booking id + plate; override needs a note', async () => {
    const client = clientWith(rawCheckOut());
    const api = createOperatorApi(client);
    await api.checkOut({ target: { kind: 'manual', bookingId: BOOKING_ID, plate: '01A123BC' }, lotId: LOT_ID, collect: false });
    expect(client.post).toHaveBeenLastCalledWith('/operator/checkout', { booking_id: BOOKING_ID, plate_number: '01A123BC', parking_lot_id: LOT_ID, collect: false }, expect.anything());
    await api.checkOut({ target: { kind: 'manual', bookingId: BOOKING_ID, plate: '01A123BC', overrideNote: 'telefon o‘lgan' }, lotId: LOT_ID, collect: false });
    expect(client.post).toHaveBeenLastCalledWith(
      '/operator/checkout',
      { booking_id: BOOKING_ID, plate_number: '01A123BC', parking_lot_id: LOT_ID, collect: false, override: true, note: 'telefon o‘lgan' },
      expect.anything(),
    );
  });

  it('refuses a bad booking id', async () => {
    const api = createOperatorApi(clientWith(rawCheckOut()));
    await expect(api.checkOut({ target: { kind: 'manual', bookingId: 'x', plate: 'P' }, lotId: LOT_ID, collect: false })).rejects.toBeInstanceOf(ContractError);
  });
});

describe('walkIn / setSlotStatus / acceptInvite', () => {
  it('walk-in sends slot, plate and the mandatory vehicle type', async () => {
    const client = clientWith(rawWalkIn(), 201);
    const r = await createOperatorApi(client).walkIn({ slotId: SLOT_ID, plateNumber: '01A123BC', vehicleType: 'CAR' });
    expect(client.post).toHaveBeenCalledWith('/operator/walk-in', { slot_id: SLOT_ID, plate_number: '01A123BC', vehicle_type: 'CAR' }, expect.anything());
    expect(r.result).toBe('registered');
  });

  it('PATCH slot: status and force flag, id in the path', async () => {
    const client = clientWith({ id: SLOT_ID, code: 'A-12', status: 'OUT_OF_SERVICE', affected_bookings: 0 });
    const r = await createOperatorApi(client).setSlotStatus({ slotId: SLOT_ID, status: 'OUT_OF_SERVICE', force: true });
    expect(client.patch).toHaveBeenCalledWith(`/operator/slots/${SLOT_ID}`, { status: 'OUT_OF_SERVICE', force: true }, expect.anything());
    expect(r.affectedBookings).toBe(0);
    await expect(createOperatorApi(client).setSlotStatus({ slotId: '1/../2', status: 'FREE', force: false })).rejects.toBeInstanceOf(ContractError);
  });

  it('accept invite posts the normalised code only', async () => {
    const client = clientWith({ parking_lot: { id: LOT_ID, name: 'Chorsu' } });
    const r = await createOperatorApi(client).acceptInvite('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(client.post).toHaveBeenCalledWith('/me/operator-invites/accept', { code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }, expect.anything());
    expect(r).toEqual({ lotId: LOT_ID, lotName: 'Chorsu' });
  });

  it('requests carry no params / URL query that could hold a token or a plate', async () => {
    const client = clientWith(rawCheckIn());
    await createOperatorApi(client).checkIn({ token: TOKEN, lotId: LOT_ID, plate: '01A123BC' });
    const [url, , config] = client.post.mock.calls[0] ?? [];
    expect(String(url)).not.toContain('?');
    expect((config as { params?: unknown }).params).toBeUndefined();
  });
});
