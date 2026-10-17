import { describe, expect, it } from 'vitest';

import { rawMapBooking, rawMapSlot, rawSlotMap } from '@/features/operator/fixtures';
import { parseSlotMap } from '@/features/operator/operatorSchemas';
import {
  availableSlotActions,
  describeBooking,
  groupSlots,
  slotCounts,
  slotVisual,
} from '@/features/operator/slotView';

function slots(...raw: Record<string, unknown>[]) {
  return parseSlotMap(rawSlotMap(raw)).slots;
}
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

describe('slotVisual', () => {
  it('each kind has a glyph, an i18n label and a palette role (never colour alone)', () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [rawMapSlot({ status: 'FREE' }), 'free', 'success'],
      [rawMapSlot({ status: 'OCCUPIED', current_booking: rawMapBooking() }), 'occupied', 'primary'],
      [rawMapSlot({ status: 'RESERVED' }), 'reserved', 'warning'],
      [rawMapSlot({ status: 'OUT_OF_SERVICE' }), 'out_of_service', 'muted'],
      [rawMapSlot({ status: 'OCCUPIED', current_booking: rawMapBooking({ status: 'OVERSTAY' }) }), 'overstay', 'error'],
      [rawMapSlot({ status: 'WEIRD' }), 'unknown', 'muted'],
    ];
    const glyphs = new Set<string>();
    for (const [raw, kind, tone] of cases) {
      const v = slotVisual(slots(raw)[0]!);
      expect(v).toMatchObject({ kind, tone, labelKey: `operator.slot.${kind}` });
      expect(v.glyph.length).toBeGreaterThan(0);
      glyphs.add(v.glyph);
    }
    expect(glyphs.size).toBe(cases.length);
  });

  it('a car in OVERSTAY wins over whatever status the slot has', () => {
    expect(slotVisual(slots(rawMapSlot({ status: 'RESERVED', current_booking: rawMapBooking({ status: 'OVERSTAY' }) }))[0]!).kind).toBe('overstay');
  });
});

describe('groupSlots', () => {
  it('groups by floor then zone and orders codes naturally', () => {
    const list = slots(
      rawMapSlot({ id: id(), code: 'B-10', zone: 'B', floor: 2 }),
      rawMapSlot({ id: id(), code: 'A-2', zone: 'A', floor: 1 }),
      rawMapSlot({ id: id(), code: 'A-10', zone: 'A', floor: 1 }),
      rawMapSlot({ id: id(), code: 'C-1', zone: 'C', floor: -1 }),
      rawMapSlot({ id: id(), code: 'B-9', zone: 'B', floor: 2 }),
    );
    const groups = groupSlots(list);
    expect(groups.map((g) => g.floor)).toEqual([-1, 1, 2]);
    expect(groups[1]?.zones[0]?.slots.map((s) => s.code)).toEqual(['A-2', 'A-10']);
    expect(groups[2]?.zones[0]?.slots.map((s) => s.code)).toEqual(['B-9', 'B-10']);
  });

  it('empty input gives no groups, and the input is not mutated', () => {
    expect(groupSlots([])).toEqual([]);
    const list = slots(rawMapSlot({ id: id(), code: 'Z-2' }), rawMapSlot({ id: id(), code: 'Z-1' }));
    const copy = [...list];
    groupSlots(list);
    expect(list).toEqual(copy);
  });

  it('keeps several zones of one floor apart', () => {
    const groups = groupSlots(slots(rawMapSlot({ id: id(), zone: 'B', code: 'B-1' }), rawMapSlot({ id: id(), zone: 'A', code: 'A-1' })));
    expect(groups[0]?.zones.map((z) => z.zone)).toEqual(['A', 'B']);
  });
});

describe('slotCounts', () => {
  it('counts every kind (also zero)', () => {
    const counts = slotCounts(
      slots(
        rawMapSlot({ id: id(), status: 'FREE' }),
        rawMapSlot({ id: id(), status: 'FREE' }),
        rawMapSlot({ id: id(), status: 'OUT_OF_SERVICE' }),
      ),
    );
    expect(counts).toMatchObject({ free: 2, out_of_service: 1, occupied: 0, reserved: 0, overstay: 0, unknown: 0 });
  });
});

describe('describeBooking', () => {
  it('shows the plate and the period of a current booking', () => {
    const [slot] = slots(rawMapSlot({ status: 'OCCUPIED', current_booking: rawMapBooking() }));
    expect(describeBooking(slot!.current!)).toMatchObject({ plate: '01A123BC', plateHidden: false, kind: 'ONLINE' });
  });

  it('a hidden plate (next booking further than 2 h) is flagged, not guessed', () => {
    const [slot] = slots(rawMapSlot({ next_booking: rawMapBooking({ plate_number: null, status: 'CONFIRMED' }) }));
    expect(describeBooking(slot!.next!)).toMatchObject({ plate: null, plateHidden: true });
  });
});

describe('availableSlotActions', () => {
  const [free] = slots(rawMapSlot({ status: 'FREE' }));
  const [oos] = slots(rawMapSlot({ status: 'OUT_OF_SERVICE' }));
  const [busy] = slots(rawMapSlot({ status: 'OCCUPIED', current_booking: rawMapBooking() }));
  const [reserved] = slots(rawMapSlot({ status: 'RESERVED' }));

  it('FREE / RESERVED can be taken out of service; OUT_OF_SERVICE can be freed', () => {
    expect(availableSlotActions(free!, 'ACTIVE')).toEqual({ markOutOfService: true, markFree: false });
    expect(availableSlotActions(reserved!, 'ACTIVE')).toEqual({ markOutOfService: true, markFree: false });
    expect(availableSlotActions(oos!, 'ACTIVE')).toEqual({ markOutOfService: false, markFree: true });
  });

  it('a slot with a car cannot be changed (slot_in_use)', () => {
    expect(availableSlotActions(busy!, 'ACTIVE')).toEqual({ markOutOfService: false, markFree: false });
  });

  it('no manual slot changes in a lot that is not ACTIVE', () => {
    for (const status of ['SUSPENDED', 'PENDING_REVIEW', 'unknown'] as const) {
      expect(availableSlotActions(free!, status)).toEqual({ markOutOfService: false, markFree: false });
      expect(availableSlotActions(oos!, status)).toEqual({ markOutOfService: false, markFree: false });
    }
  });
});
