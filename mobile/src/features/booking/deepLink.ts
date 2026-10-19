import { isUuid } from '@/lib/contract';

export type BookingParam = { ok: true; id: string } | { ok: false };

/**
 * `parkbor://booking/<id>` (push, Telegram button) and in-app links: the id is untrusted text.
 * Anything that is not a plain UUID - including path/query smuggling such as "<id>/cancel" - is
 * refused and the caller sends the user to the bookings list.
 */
export function resolveBookingParam(param: string | string[] | undefined): BookingParam {
  const value = Array.isArray(param) ? param[0] : param;
  return isUuid(value) ? { ok: true, id: value } : { ok: false };
}
