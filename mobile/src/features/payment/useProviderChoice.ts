import { useState, type Dispatch, type SetStateAction } from 'react';

import { initialProviderChoice, type ProviderChoice } from '@/features/payment/providerChoice';

/**
 * Provider choice of one booking form (state only; the rules are in `providerChoice`). It starts
 * empty each time the form opens: what the server refused is re-learned from its first answer.
 */
export function useProviderChoice(): [ProviderChoice, Dispatch<SetStateAction<ProviderChoice>>] {
  return useState<ProviderChoice>(initialProviderChoice);
}
