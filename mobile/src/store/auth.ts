import { useStore } from 'zustand';

import { authStore } from '@/lib/api';
import type { AuthState } from '@/store/createAuthStore';

export { authStore };

/** React hook over the app-wide auth store. */
export function useAuthStore<T>(selector: (state: AuthState) => T): T {
  return useStore(authStore, selector);
}
