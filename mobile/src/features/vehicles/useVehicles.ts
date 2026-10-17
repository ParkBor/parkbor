import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { vehicleKeys } from '@/features/booking/queryKeys';
import { useIsAuthenticated } from '@/features/booking/useAuthenticated';
import { shouldRetry } from '@/features/map/mapError';
import type { VehicleFormValues } from '@/features/vehicles/schemas';
import { vehiclesApi } from '@/features/vehicles/vehiclesApi';

const STALE_TIME_MS = 60_000;

/** The driver's vehicles (<= 10, not paginated). In-memory cache only. */
export function useVehicles() {
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    enabled: isAuthenticated,
    queryKey: vehicleKeys.all,
    queryFn: ({ signal }) => vehiclesApi.list(signal),
    staleTime: STALE_TIME_MS,
    retry: shouldRetry,
  });
}

/** Create (no `id`) or replace (PUT, with `id`). */
export function useSaveVehicle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string | null; values: VehicleFormValues }) =>
      id === null ? vehiclesApi.create(values) : vehiclesApi.update(id, values),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: vehicleKeys.all }),
  });
}

export function useRemoveVehicle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => vehiclesApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: vehicleKeys.all }),
  });
}
