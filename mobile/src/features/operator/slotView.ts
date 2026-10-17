import type { BookingKind, LotStatus, MapBooking, MapSlot } from '@/features/operator/operatorSchemas';

export type SlotKind = 'free' | 'occupied' | 'reserved' | 'out_of_service' | 'overstay' | 'unknown';
/** Palette roles (resolved to colours by the UI, in light and dark mode). */
export type SlotTone = 'success' | 'primary' | 'warning' | 'error' | 'muted';

export interface SlotVisual {
  kind: SlotKind;
  /** Shown inside the cell next to the code: state must not depend on colour alone. */
  glyph: string;
  labelKey: string;
  tone: SlotTone;
}

const VISUALS: Record<SlotKind, { glyph: string; tone: SlotTone }> = {
  free: { glyph: '○', tone: 'success' },
  occupied: { glyph: '●', tone: 'primary' },
  reserved: { glyph: '◐', tone: 'warning' },
  out_of_service: { glyph: '✕', tone: 'muted' },
  overstay: { glyph: '!', tone: 'error' },
  unknown: { glyph: '?', tone: 'muted' },
};

export const SLOT_KINDS = Object.keys(VISUALS) as SlotKind[];

function kindOf(slot: MapSlot): SlotKind {
  if (slot.current?.status === 'OVERSTAY') return 'overstay';
  switch (slot.status) {
    case 'FREE':
      return 'free';
    case 'OCCUPIED':
      return 'occupied';
    case 'RESERVED':
      return 'reserved';
    case 'OUT_OF_SERVICE':
      return 'out_of_service';
    default:
      return 'unknown';
  }
}

export function kindVisual(kind: SlotKind): SlotVisual {
  return { kind, labelKey: `operator.slot.${kind}`, ...VISUALS[kind] };
}

export function slotVisual(slot: MapSlot): SlotVisual {
  return kindVisual(kindOf(slot));
}

export function slotCounts(slots: readonly MapSlot[]): Record<SlotKind, number> {
  const counts = Object.fromEntries(SLOT_KINDS.map((kind) => [kind, 0])) as Record<SlotKind, number>;
  for (const slot of slots) counts[kindOf(slot)] += 1;
  return counts;
}

export interface ZoneGroup {
  zone: string;
  slots: MapSlot[];
}

export interface FloorGroup {
  floor: number;
  zones: ZoneGroup[];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Floor -> zone -> slots, each level ordered (numeric-aware: A-2 before A-10). Input is not mutated. */
export function groupSlots(slots: readonly MapSlot[]): FloorGroup[] {
  const sorted = [...slots].sort((a, b) => a.floor - b.floor || collator.compare(a.zone, b.zone) || collator.compare(a.code, b.code));
  const floors: FloorGroup[] = [];
  for (const slot of sorted) {
    let floor = floors[floors.length - 1];
    if (!floor || floor.floor !== slot.floor) {
      floor = { floor: slot.floor, zones: [] };
      floors.push(floor);
    }
    let zone = floor.zones[floor.zones.length - 1];
    if (!zone || zone.zone !== slot.zone) {
      zone = { zone: slot.zone, slots: [] };
      floor.zones.push(zone);
    }
    zone.slots.push(slot);
  }
  return floors;
}

export interface BookingLine {
  id: string;
  plate: string | null;
  /** The server hides the plate of a booking that starts more than 2 hours from now. */
  plateHidden: boolean;
  kind: BookingKind;
  status: string;
  startMs: number;
  endMs: number;
}

export function describeBooking(booking: MapBooking): BookingLine {
  return {
    id: booking.id,
    plate: booking.plate,
    plateHidden: booking.plate === null,
    kind: booking.kind,
    status: booking.status,
    startMs: booking.startMs,
    endMs: booking.endMs,
  };
}

export interface SlotActions {
  markOutOfService: boolean;
  markFree: boolean;
}

/**
 * Manual slot status (PATCH accepts FREE / OUT_OF_SERVICE only). A slot with a car cannot be
 * changed (slot_in_use); nothing can be changed in a lot that is not ACTIVE. The server decides.
 */
export function availableSlotActions(slot: MapSlot, lotStatus: LotStatus): SlotActions {
  const none: SlotActions = { markOutOfService: false, markFree: false };
  if (lotStatus !== 'ACTIVE') return none;
  const kind = kindOf(slot);
  if (kind === 'free' || kind === 'reserved') return { markOutOfService: true, markFree: false };
  if (kind === 'out_of_service') return { markOutOfService: false, markFree: true };
  return none;
}
