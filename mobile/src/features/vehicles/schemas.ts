import { z } from 'zod';

import { validatePlate } from '@/features/vehicles/vehiclePlate';
import { ContractError, uuidSchema } from '@/lib/contract';

export const VEHICLE_TYPES = ['CAR', 'TRUCK', 'EV', 'DISABLED'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export interface Vehicle {
  id: string;
  /** Normalised by the server: upper-case, no spaces. */
  plateNumber: string;
  type: VehicleType;
}

const vehicleSchema = z.object({
  id: uuidSchema,
  plate_number: z.string().min(1).max(32),
  type: z.enum(VEHICLE_TYPES),
});

function toVehicle(raw: z.infer<typeof vehicleSchema>): Vehicle {
  return { id: raw.id, plateNumber: raw.plate_number, type: raw.type };
}

export function parseVehicle(data: unknown): Vehicle {
  const parsed = vehicleSchema.safeParse(data);
  if (!parsed.success) throw new ContractError('vehicle');
  return toVehicle(parsed.data);
}

/** The list is not paginated (<= 10). Malformed items are dropped; all-malformed is a violation. */
export function parseVehicleList(data: unknown): Vehicle[] {
  if (!Array.isArray(data)) throw new ContractError('vehicle list');
  const vehicles: Vehicle[] = [];
  for (const item of data as unknown[]) {
    const parsed = vehicleSchema.safeParse(item);
    if (parsed.success) vehicles.push(toVehicle(parsed.data));
  }
  if (data.length > 0 && vehicles.length === 0) throw new ContractError('vehicle list');
  return vehicles;
}

export interface VehicleFormValues {
  plate: string;
  type: VehicleType;
}

const PLATE_MESSAGE = {
  ascii: 'vehicles.validation.plateAscii',
  length: 'vehicles.validation.plateLength',
  charset: 'vehicles.validation.plateCharset',
  mix: 'vehicles.validation.plateMix',
} as const;

/** Field messages are i18n keys, resolved by the screen. */
export const vehicleFormSchema = z.object({
  plate: z.string().superRefine((value, ctx) => {
    const check = validatePlate(value);
    if (!check.ok) ctx.addIssue({ code: 'custom', message: PLATE_MESSAGE[check.reason] });
  }),
  type: z.enum(VEHICLE_TYPES, { error: 'vehicles.validation.typeRequired' }),
});

export type VehicleFormErrors = Partial<Record<'plate' | 'type', string>>;

export type VehicleFormResult = { ok: true; value: VehicleFormValues } | { ok: false; errors: VehicleFormErrors };

export function validateVehicleForm(input: { plate: string; type: string }): VehicleFormResult {
  const parsed = vehicleFormSchema.safeParse(input);
  if (!parsed.success) {
    const errors: VehicleFormErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if ((field === 'plate' || field === 'type') && errors[field] === undefined) errors[field] = issue.message;
    }
    return { ok: false, errors };
  }
  const plate = validatePlate(parsed.data.plate);
  // validatePlate already passed inside the schema; the guard keeps the types honest.
  if (!plate.ok) return { ok: false, errors: { plate: PLATE_MESSAGE[plate.reason] } };
  return { ok: true, value: { plate: plate.plate, type: parsed.data.type } };
}

export interface VehicleBody {
  plate_number: string;
  type: VehicleType;
}

/** PUT requires `type`, so both fields are always sent. */
export function toVehicleBody(values: VehicleFormValues): VehicleBody {
  return { plate_number: values.plate, type: values.type };
}
