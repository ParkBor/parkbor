import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import { classifyVehicleError, VEHICLE_ERROR_CODES } from '@/features/vehicles/vehicleErrors';
import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';
import uz from '@/i18n/uz.json';

function httpError(status: number, code?: string): AxiosError {
  const response = { status, data: code ? { code } : {}, headers: {}, statusText: '', config: {} } as unknown as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, response);
}

describe('classifyVehicleError', () => {
  it.each([
    [409, 'vehicle_exists'],
    [422, 'vehicle_limit_reached'],
    [409, 'vehicle_in_use'],
  ])('maps %i %s to its own message', (status, code) => {
    expect(classifyVehicleError(httpError(status, code)).key).toBe(`vehicles.error.${code}`);
  });

  it('has a message for every code in every language', () => {
    for (const catalog of [uz, ru, en]) {
      const errors = catalog.vehicles.error as Record<string, string>;
      for (const code of VEHICLE_ERROR_CODES) expect(errors[code], code).toBeTruthy();
    }
  });

  it('a bare 400 is a field problem the user can edit', () => {
    expect(classifyVehicleError(httpError(400))).toMatchObject({ key: 'failure.badRequest', retry: 'edit' });
  });
});
