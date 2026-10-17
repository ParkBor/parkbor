import { isUuid } from '@/lib/contract';

/**
 * The booking whose payment page was opened last (memory only, never persisted). When the provider
 * sends the user back through the system (external browser / app) the deep link may carry no id;
 * this app-side fact - not the link - says which booking to re-check.
 */
let lastBookingId: string | null = null;

export function rememberPaymentBooking(id: string): void {
  if (isUuid(id)) lastBookingId = id;
}

export function getLastPaymentBookingId(): string | null {
  return lastBookingId;
}

export function clearLastPayment(): void {
  lastBookingId = null;
}
