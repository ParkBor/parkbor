import { onlineManager, useQuery } from '@tanstack/react-query';

import { bookingApi } from '@/features/booking/bookingApi';
import { classifyBookingError } from '@/features/booking/bookingErrors';
import { qrCache } from '@/features/booking/qrStore';
import { resolveQr, type QrToken } from '@/features/booking/qrSource';
import { bookingKeys } from '@/features/booking/queryKeys';

export type { QrToken };
export type QrProblem = 'unavailable' | 'error';

const QR_STALE_MS = 30_000;

/**
 * Entry QR token of a CONFIRMED / ACTIVE booking (see resolveQr for the online/offline rules).
 * `networkMode: 'offlineFirst'` is what makes the offline copy reachable: the default ('online')
 * pauses the request while the device is offline, so the keystore fallback would never run.
 * The token is never logged, never part of the query KEY and never persisted by React Query;
 * the keystore copy is written with the epoch read before the request, so a response that
 * arrives after logout is dropped.
 */
export function useQrToken(bookingId: string | null, isEnabled: boolean) {
  const query = useQuery({
    queryKey: bookingKeys.qr(bookingId ?? 'none'),
    enabled: isEnabled && bookingId !== null,
    networkMode: 'offlineFirst',
    staleTime: QR_STALE_MS,
    gcTime: 5 * 60_000,
    retry: false,
    queryFn: ({ signal }): Promise<QrToken> => {
      const id = bookingId ?? '';
      const epoch = qrCache.epoch();
      return resolveQr({
        isOnline: onlineManager.isOnline(),
        nowMs: Date.now(),
        loadCached: () => qrCache.load(id),
        fetchFresh: async () => {
          const qr = await bookingApi.qr(id, signal);
          await qrCache.save(id, { token: qr.token, expiresAtMs: qr.expiresAtMs }, epoch);
          return qr;
        },
        isNetworkError: (error) => classifyBookingError(error).key === 'failure.network',
      });
    },
  });

  let problem: QrProblem | null = null;
  if (query.isError) problem = classifyBookingError(query.error).code === 'qr_not_available' ? 'unavailable' : 'error';
  return { ...query, problem };
}
