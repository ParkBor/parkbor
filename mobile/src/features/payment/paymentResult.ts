import { isResultUrl } from '@/features/payment/webviewPolicy';
import { isUuid } from '@/lib/contract';

/**
 * `habi://payment/result` is only a "the user came back" SIGNAL. The only thing read from it is a
 * booking id (when it is a plain UUID); a status, amount or "success" flag in the link is ignored on
 * purpose - the truth is the server booking (webhook), never the redirect.
 */
export interface PaymentResultSignal {
  bookingId: string | null;
}

/** Query names a provider / return URL may carry the booking id under. Order = priority. */
const ID_KEYS = ['id', 'booking', 'booking_id', 'bookingId', 'order_id', 'transaction_param'] as const;

type ParamValue = string | string[] | undefined;

function firstValue(value: ParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Params as expo-router gives them (own properties only). */
export function parsePaymentResultParams(params: Readonly<Record<string, ParamValue>>): PaymentResultSignal {
  for (const key of ID_KEYS) {
    if (!Object.hasOwn(params, key)) continue;
    const value = firstValue(params[key]);
    if (isUuid(value)) return { bookingId: value };
  }
  return { bookingId: null };
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

function queryParams(url: string): Record<string, string> {
  const start = url.indexOf('?');
  if (start === -1) return {};
  const hash = url.indexOf('#', start);
  const query = url.slice(start + 1, hash === -1 ? undefined : hash);
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=');
    const key = safeDecode(rawKey ?? '');
    const value = safeDecode(rawValue);
    if (key !== null && key !== '' && value !== null && !Object.hasOwn(params, key)) params[key] = value;
  }
  return params;
}

/** The signal inside a result link, or null when `url` is not the result link at all. */
export function parsePaymentResultUrl(url: unknown): PaymentResultSignal | null {
  if (!isResultUrl(url)) return null;
  return parsePaymentResultParams(queryParams(url));
}
