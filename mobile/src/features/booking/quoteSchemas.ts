import { z } from 'zod';

import { SLOT_TYPES } from '@/features/map/schemas';
import { ContractError, instantSchema, moneySchema } from '@/lib/contract';

const count = z.number().int().min(0);
const slotType = z.string().refine((value) => (SLOT_TYPES as readonly string[]).includes(value), 'slot type');
const factor = z.string().regex(/^\d{1,4}(?:\.\d{1,6})?$/);

const availabilitySchema = z
  .object({
    slot_type: slotType.nullable(),
    start: instantSchema,
    end: instantSchema,
    total: count,
    available: count,
    is_open: z.boolean(),
  })
  .refine((value) => value.available <= value.total, 'available > total');

export interface Availability {
  slotType: string | null;
  startMs: number;
  endMs: number;
  total: number;
  /** Slots that can take the WHOLE period. */
  available: number;
  /** The period fits the lot's working hours. */
  isOpen: boolean;
}

export function parseAvailability(data: unknown): Availability {
  const parsed = availabilitySchema.safeParse(data);
  if (!parsed.success) throw new ContractError('availability');
  const v = parsed.data;
  return { slotType: v.slot_type, startMs: v.start, endMs: v.end, total: v.total, available: v.available, isOpen: v.is_open };
}

const priceSchema = z.object({
  slot_type: slotType,
  start: instantSchema,
  end: instantSchema,
  price_per_hour: moneySchema,
  total_minutes: count,
  free_minutes: count,
  billed_minutes: count,
  segments: z.array(
    z.object({
      start: instantSchema,
      end: instantSchema,
      minutes: count,
      coefficient: factor,
      amount: moneySchema,
    }),
  ),
  subtotal: moneySchema,
  occupancy: factor.nullable(),
  dynamic_factor: factor,
  total: moneySchema,
  available_slots: count,
});

export interface PriceSegment {
  startMs: number;
  endMs: number;
  minutes: number;
  /** Decimal string, e.g. "1.5". */
  coefficient: string;
  amount: string;
}

export interface Price {
  slotType: string;
  startMs: number;
  endMs: number;
  pricePerHour: string;
  totalMinutes: number;
  freeMinutes: number;
  billedMinutes: number;
  segments: PriceSegment[];
  subtotal: string;
  occupancy: string | null;
  dynamicFactor: string;
  /** What `Booking.amount` will be if the booking is created now. Indicative: fixed on creation. */
  total: string;
  availableSlots: number;
}

export function parsePrice(data: unknown): Price {
  const parsed = priceSchema.safeParse(data);
  if (!parsed.success) throw new ContractError('price');
  const v = parsed.data;
  return {
    slotType: v.slot_type,
    startMs: v.start,
    endMs: v.end,
    pricePerHour: v.price_per_hour,
    totalMinutes: v.total_minutes,
    freeMinutes: v.free_minutes,
    billedMinutes: v.billed_minutes,
    segments: v.segments.map((s) => ({
      startMs: s.start,
      endMs: s.end,
      minutes: s.minutes,
      coefficient: s.coefficient,
      amount: s.amount,
    })),
    subtotal: v.subtotal,
    occupancy: v.occupancy,
    dynamicFactor: v.dynamic_factor,
    total: v.total,
    availableSlots: v.available_slots,
  };
}
