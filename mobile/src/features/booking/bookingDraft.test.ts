import { describe, expect, it } from 'vitest';

import {
  adjustDuration,
  applyQuickDuration,
  createDraft,
  draftDurationMin,
  draftProblems,
  selectDay,
  selectSlotType,
  selectStart,
  selectVehicle,
  toPayload,
} from '@/features/booking/bookingDraft';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-10-15 14:07 Asia/Tashkent. */
const NOW = Date.UTC(2026, 9, 15, 9, 7, 0);
const MIDNIGHT = Date.UTC(2026, 9, 14, 19, 0, 0);
const at = (h: number, m = 0): number => MIDNIGHT + h * HOUR + m * MIN;
const LOT = 'b2f0c1de-1111-4222-8333-444455556666';
const CAR = { id: 'a91c1de0-1111-4222-8333-444455556666', type: 'CAR' };
const EV = { id: 'c91c1de0-1111-4222-8333-444455556666', type: 'EV' };

describe('createDraft', () => {
  it('starts at the next 15-minute step for an hour, standard slot, no vehicle', () => {
    expect(createDraft(NOW)).toEqual({
      day: 'today',
      startMs: at(14, 15),
      endMs: at(15, 15),
      slotType: 'STANDARD',
      vehicleId: null,
    });
  });

  it('honours a preselected slot type', () => {
    expect(createDraft(NOW, 'EV').slotType).toBe('EV');
  });

  it('moves to tomorrow late in the evening', () => {
    expect(createDraft(at(23, 50)).day).toBe('tomorrow');
  });
});

describe('time edits keep the duration', () => {
  const draft = createDraft(NOW);

  it('selectStart shifts the end', () => {
    const next = selectStart(draft, at(16));
    expect(next.startMs).toBe(at(16));
    expect(draftDurationMin(next)).toBe(60);
    expect(draft.startMs).toBe(at(14, 15)); // immutable
  });

  it('selectDay keeps the clock time and the duration', () => {
    const next = selectDay(draft, 'tomorrow', NOW);
    expect(next.day).toBe('tomorrow');
    expect(next.startMs).toBe(at(24 + 14, 15));
    expect(draftDurationMin(next)).toBe(60);
  });

  it('selectDay back to today snaps a past clock time to the first free step', () => {
    const tomorrow = selectStart(selectDay(draft, 'tomorrow', NOW), at(24 + 9));
    const today = selectDay(tomorrow, 'today', NOW);
    expect(today.startMs).toBe(at(14, 15));
    expect(draftDurationMin(today)).toBe(60);
  });

  it('applyQuickDuration sets 1, 2 or 3 hours', () => {
    expect(draftDurationMin(applyQuickDuration(draft, 120))).toBe(120);
    expect(draftDurationMin(applyQuickDuration(draft, 180))).toBe(180);
  });

  it('adjustDuration steps by 15 minutes and clamps to 30 min .. 24 h', () => {
    expect(draftDurationMin(adjustDuration(draft, 15))).toBe(75);
    expect(draftDurationMin(adjustDuration(draft, -15))).toBe(45);
    expect(draftDurationMin(adjustDuration(adjustDuration(draft, -15), -60))).toBe(30);
    expect(draftDurationMin(adjustDuration(applyQuickDuration(draft, 1440), 15))).toBe(1440);
  });
});

describe('vehicle and slot type', () => {
  it('selectVehicle stores the id only and does not silently change the slot type', () => {
    const next = selectVehicle(selectSlotType(createDraft(NOW), 'LARGE'), CAR);
    expect(next.vehicleId).toBe(CAR.id);
    expect(next.slotType).toBe('LARGE');
  });

  it('selectVehicle(null) clears it', () => {
    expect(selectVehicle(selectVehicle(createDraft(NOW), CAR), null).vehicleId).toBeNull();
  });
});

describe('draftProblems', () => {
  const ready = selectVehicle(createDraft(NOW), CAR);

  it('a complete draft has no problems', () => {
    expect(draftProblems(ready, CAR, NOW, null)).toEqual([]);
  });

  it('asks for a vehicle first', () => {
    expect(draftProblems(createDraft(NOW), null, NOW, null)).toEqual(['no_vehicle']);
  });

  it('warns before the server does when vehicle and slot type do not match', () => {
    const evDraft = selectSlotType(selectVehicle(createDraft(NOW), CAR), 'EV');
    expect(draftProblems(evDraft, CAR, NOW, null)).toEqual(['vehicle_slot_mismatch']);
    expect(draftProblems(evDraft, EV, NOW, null)).toEqual([]);
  });

  it('reports period problems with the server codes', () => {
    const tooShort = { ...ready, endMs: ready.startMs + 15 * MIN };
    expect(draftProblems(tooShort, CAR, NOW, null)).toEqual(['period_too_short']);
    const past = { ...ready, startMs: NOW - HOUR, endMs: NOW };
    expect(draftProblems(past, CAR, NOW, null)).toContain('start_in_past');
  });

  it('reports a closed lot when hours are known', () => {
    const night = { ...ready, startMs: at(23), endMs: at(24, 30) };
    expect(draftProblems(night, CAR, NOW, { open: '08:00', close: '22:00' })).toEqual(['lot_closed']);
  });
});

describe('toPayload', () => {
  it('builds the request from the draft', () => {
    const draft = selectVehicle(createDraft(NOW, 'EV'), EV);
    expect(toPayload(draft, LOT)).toEqual({
      parkingLotId: LOT,
      slotType: 'EV',
      vehicleId: EV.id,
      startMs: draft.startMs,
      endMs: draft.endMs,
      preferredSlotId: null,
      paymentProvider: null,
    });
  });

  it('carries the chosen payment provider', () => {
    const draft = selectVehicle(createDraft(NOW), CAR);
    expect(toPayload(draft, LOT, 'click')?.paymentProvider).toBe('click');
  });

  it('is null without a vehicle or with a malformed lot id', () => {
    expect(toPayload(createDraft(NOW), LOT)).toBeNull();
    expect(toPayload(selectVehicle(createDraft(NOW), CAR), 'not-a-uuid')).toBeNull();
  });
});
