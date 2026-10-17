import { useAuthStore } from '@/store/auth';

/** Data hooks wait for a confirmed session: no request leaves before authentication is known. */
export function useIsAuthenticated(): boolean {
  return useAuthStore((state) => state.status === 'authenticated');
}
