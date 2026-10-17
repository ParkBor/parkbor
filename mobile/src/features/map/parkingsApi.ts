import type { AxiosInstance } from 'axios';

import { parseNearbyResponse, type NearbyResponse } from '@/features/map/schemas';
import type { NearbyParams } from '@/features/map/search';
import { api } from '@/lib/api';

export interface ParkingsApi {
  nearby(params: NearbyParams, signal?: AbortSignal): Promise<NearbyResponse>;
}

export function createParkingsApi(client: Pick<AxiosInstance, 'get'>): ParkingsApi {
  return {
    async nearby(params, signal) {
      const response = await client.get<unknown>('/parkings/nearby', {
        params: {
          lat: params.lat,
          lng: params.lng,
          radius: params.radiusM,
          ...(params.slotType ? { slot_type: params.slotType } : {}),
          limit: params.limit,
          sort: params.sort,
          only_open: params.onlyOpen,
        },
        signal,
      });
      return parseNearbyResponse(response.data);
    },
  };
}

/** Authenticated client: the Bearer token and 401 -> refresh handling live in `api`. */
export const parkingsApi: ParkingsApi = createParkingsApi(api);
