import { describe, expect, it } from 'vitest';

import { rawLot, rawLotPage, LOT_ID_2 } from '@/features/operator/fixtures';
import { effectivePlateCheck, lotCapabilities, resolveEntryPlate } from '@/features/operator/lotPolicy';
import { parseLotPage } from '@/features/operator/operatorSchemas';
import { createOperatorStore, resolveActiveLot } from '@/features/operator/operatorStore';

const lots = parseLotPage(rawLotPage([rawLot(), rawLot({ id: LOT_ID_2, name: 'Next Mall', status: 'SUSPENDED' })])).results;

describe('lotCapabilities', () => {
  it('ACTIVE lot: everything works', () => {
    expect(lotCapabilities(lots[0] ?? null)).toEqual({ canCheckIn: true, canWalkIn: true, canSetSlotStatus: true, canCheckOut: true, notice: null });
  });

  it('SUSPENDED / PENDING_REVIEW: only exit (and reading) works, with the reason', () => {
    expect(lotCapabilities(lots[1] ?? null)).toEqual({ canCheckIn: false, canWalkIn: false, canSetSlotStatus: false, canCheckOut: true, notice: 'operator.lot.suspended' });
    const review = parseLotPage(rawLotPage([rawLot({ status: 'PENDING_REVIEW' })])).results[0] ?? null;
    expect(lotCapabilities(review)).toMatchObject({ canCheckIn: false, canCheckOut: true, notice: 'operator.lot.pending_review' });
  });

  it('an unknown status fails closed for entry but never traps a car', () => {
    const odd = parseLotPage(rawLotPage([rawLot({ status: 'X' })])).results[0] ?? null;
    expect(lotCapabilities(odd)).toMatchObject({ canCheckIn: false, canWalkIn: false, canCheckOut: true, notice: 'operator.lot.inactive' });
  });

  it('no lot selected: nothing is possible', () => {
    expect(lotCapabilities(null)).toEqual({ canCheckIn: false, canWalkIn: false, canSetSlotStatus: false, canCheckOut: false, notice: 'operator.lot.none' });
  });
});

describe('effectivePlateCheck (plate toggle decision: default OFF, forced ON by the lot)', () => {
  const required = parseLotPage(rawLotPage([rawLot({ require_plate_on_checkin: true })])).results[0] ?? null;

  it('is off by default and follows the operator toggle', () => {
    expect(effectivePlateCheck(lots[0] ?? null, false)).toEqual({ enabled: false, locked: false });
    expect(effectivePlateCheck(lots[0] ?? null, true)).toEqual({ enabled: true, locked: false });
  });

  it('a lot that requires the plate forces it on and locks the switch', () => {
    expect(effectivePlateCheck(required, false)).toEqual({ enabled: true, locked: true });
    expect(effectivePlateCheck(required, true)).toEqual({ enabled: true, locked: true });
  });
});

describe('resolveEntryPlate', () => {
  it('check off: no plate is sent, whatever was typed', () => {
    expect(resolveEntryPlate({ enabled: false, locked: false }, '01A123BC')).toEqual({ ok: true, plate: null });
  });

  it('check on: a valid plate is normalised and sent', () => {
    expect(resolveEntryPlate({ enabled: true, locked: false }, ' 01 a 123 bc ')).toEqual({ ok: true, plate: '01A123BC' });
  });

  it('check on: an empty or invalid plate blocks scanning', () => {
    expect(resolveEntryPlate({ enabled: true, locked: true }, '')).toEqual({ ok: false, reason: 'empty' });
    expect(resolveEntryPlate({ enabled: true, locked: true }, 'AB')).toEqual({ ok: false, reason: 'length' });
  });
});

describe('resolveActiveLot / operator store', () => {
  it('uses the only lot, the chosen lot, or asks', () => {
    expect(resolveActiveLot(lots.slice(0, 1), null)?.id).toBe(lots[0]?.id);
    expect(resolveActiveLot(lots, LOT_ID_2)?.id).toBe(LOT_ID_2);
    expect(resolveActiveLot(lots, null)).toBeNull();
    expect(resolveActiveLot(lots, 'gone')).toBeNull();
    expect(resolveActiveLot([], 'x')).toBeNull();
  });

  it('stores the chosen lot and plate toggles in memory only, and reset clears everything', () => {
    const store = createOperatorStore();
    store.getState().selectLot(LOT_ID_2);
    store.getState().setVerifyPlate(LOT_ID_2, true);
    store.getState().setMode('exit');
    expect(store.getState()).toMatchObject({ selectedLotId: LOT_ID_2, verifyPlate: { [LOT_ID_2]: true }, mode: 'exit' });
    store.getState().setVerifyPlate(LOT_ID_2, false);
    expect(store.getState().verifyPlate[LOT_ID_2]).toBe(false);
    store.getState().reset();
    expect(store.getState()).toMatchObject({ selectedLotId: null, verifyPlate: {}, mode: 'entry' });
  });

  it('remembers a result that arrived after the screen was left, until it is shown once', () => {
    const store = createOperatorStore();
    expect(store.getState().takeLostResult()).toBe(false);
    store.getState().markLostResult();
    expect(store.getState().lostResult).toBe('gate');
    expect(store.getState().takeLostResult()).toBe(true);
    expect(store.getState().takeLostResult()).toBe(false);
    store.getState().markLostResult();
    store.getState().reset();
    expect(store.getState().lostResult).toBeNull();
  });

  it('a walk-in result and a gate result are remembered separately', () => {
    const store = createOperatorStore();
    store.getState().markLostResult('walk_in');
    expect(store.getState().takeLostResult('gate')).toBe(false);
    expect(store.getState().takeLostResult('walk_in')).toBe(true);
    expect(store.getState().takeLostResult('walk_in')).toBe(false);
  });

  it('tracks a pending cash step (so a screen rebuild can keep the cash panel) and reset clears it', () => {
    const store = createOperatorStore();
    expect(store.getState().cashPending).toBe(false);
    store.getState().setCashPending(true);
    expect(store.getState().cashPending).toBe(true);
    store.getState().reset();
    expect(store.getState().cashPending).toBe(false);
  });

  it('updates do not mutate the previous toggle map', () => {
    const store = createOperatorStore();
    const before = store.getState().verifyPlate;
    store.getState().setVerifyPlate('a', true);
    expect(before).toEqual({});
  });
});
