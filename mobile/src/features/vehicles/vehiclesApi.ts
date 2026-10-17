import type { AxiosInstance } from 'axios';

import {
  parseVehicle,
  parseVehicleList,
  toVehicleBody,
  type Vehicle,
  type VehicleFormValues,
} from '@/features/vehicles/schemas';
import { api } from '@/lib/api';
import { ContractError, isUuid } from '@/lib/contract';

export interface VehiclesApi {
  list(signal?: AbortSignal): Promise<Vehicle[]>;
  create(values: VehicleFormValues): Promise<Vehicle>;
  update(id: string, values: VehicleFormValues): Promise<Vehicle>;
  remove(id: string): Promise<void>;
}

type VehiclesClient = Pick<AxiosInstance, 'get' | 'post' | 'put' | 'delete'>;

function assertId(id: string): void {
  if (!isUuid(id)) throw new ContractError('vehicle id');
}

export function createVehiclesApi(client: VehiclesClient): VehiclesApi {
  return {
    async list(signal) {
      const response = await client.get<unknown>('/vehicles', { signal });
      return parseVehicleList(response.data);
    },
    async create(values) {
      const response = await client.post<unknown>('/vehicles', toVehicleBody(values));
      return parseVehicle(response.data);
    },
    async update(id, values) {
      assertId(id);
      const response = await client.put<unknown>(`/vehicles/${id}`, toVehicleBody(values));
      return parseVehicle(response.data);
    },
    async remove(id) {
      assertId(id);
      await client.delete(`/vehicles/${id}`);
    },
  };
}

export const vehiclesApi: VehiclesApi = createVehiclesApi(api);
