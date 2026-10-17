import { describeFailure, type CodeRules, type Failure } from '@/lib/failure';

const RULES: CodeRules = {
  vehicle_exists: { retry: 'edit' },
  vehicle_limit_reached: { retry: 'none' },
  vehicle_in_use: { retry: 'none' },
};

export const VEHICLE_ERROR_CODES: readonly string[] = Object.keys(RULES);

/** 409 vehicle_exists / vehicle_in_use, 422 vehicle_limit_reached -> `vehicles.error.<code>`. */
export function classifyVehicleError(error: unknown): Failure {
  return describeFailure(error, RULES, 'vehicles.error');
}
