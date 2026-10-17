import { randomUUID } from 'expo-crypto';

import { createIdempotencyKeeper } from '@/features/booking/idempotencyKey';

/** One keeper for the whole app run (memory only). Renewed on session end in app/_layout. */
export const bookingKeeper = createIdempotencyKeeper(() => randomUUID());
