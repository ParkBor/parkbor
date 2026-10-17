import Constants from 'expo-constants';

import { isSandboxAllowed, setPaymentSandbox } from '@/features/payment/paymentSandbox';

/**
 * Called once at start-up (app/_layout). The Payme test host is accepted only in a dev client
 * (`__DEV__`) or when the build flag AND a non-production API agree (`isSandboxAllowed`); a
 * production build refuses the flag at config time (config/paymentSandbox.js).
 */
export function initPaymentEnv(): void {
  const extra: Record<string, unknown> = Constants.expoConfig?.extra ?? {};
  setPaymentSandbox(
    isSandboxAllowed({ isDev: __DEV__, flag: extra.paymentSandbox, apiUrl: extra.apiUrl, channel: extra.buildChannel }),
  );
}
