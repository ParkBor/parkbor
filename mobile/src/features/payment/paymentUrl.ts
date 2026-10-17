import { isPaymentSandbox } from '@/features/payment/paymentSandbox';

/** Provider checkout hosts (ARCHITECTURE 9.5 / 13.5). Exact match only - never a suffix match. */
const PRODUCTION_HOSTS: readonly string[] = ['checkout.paycom.uz', 'my.click.uz'];
/** Payme test checkout; accepted only in a sandbox (dev / preview) build. */
const SANDBOX_HOSTS: readonly string[] = ['test.paycom.uz'];

/**
 * Extra hosts a TOP-LEVEL redirect may need (a bank's 3-D Secure page). EMPTY on purpose: the real
 * hosts must be measured per provider in the Payme / Click sandboxes and added here, exactly.
 */
export const THREE_DS_HOSTS: readonly string[] = [];

/** Longest payment / navigation URL we look at (Payme base64 and Click query strings are far shorter). */
export const MAX_PAYMENT_URL_LENGTH = 2048;

export interface PaymentUrlOptions {
  /** Defaults to the app-wide flag (`setPaymentSandbox`). */
  sandbox?: boolean;
  /** Defaults to `THREE_DS_HOSTS` (empty). */
  threeDsHosts?: readonly string[];
}

/** Printable ASCII only: no controls, no spaces, no non-ASCII (IDN homographs, line separators, zero-width). */
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;
/** `https://` + host ([A-Za-z0-9.-] only: no userinfo, brackets, percent, colon) + optional :port + path/query/fragment. */
const HTTPS_URL = /^https:\/\/([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(?=[/?#]|$)/i;
/** Percent-encoded control characters (C0 and DEL). */
const ENCODED_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;
const DEFAULT_HTTPS_PORT = '443';
/** DNS-style name: at least two labels, no empty label, no leading/trailing hyphen. */
const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/** The last label of an IP-like name is numeric (127.0.0.1, 2130706433.x ...). */
const NUMERIC_LAST_LABEL = /\.[0-9]+$/;

/** Lower-cased host of a structurally clean https URL (any host), or null. Ports other than 443 are refused. */
function cleanHttpsHost(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_PAYMENT_URL_LENGTH) return null;
  if (!PRINTABLE_ASCII.test(url) || url.includes('\\') || ENCODED_CONTROL.test(url)) return null;
  const match = HTTPS_URL.exec(url);
  if (match === null) return null;
  const port = match[2];
  if (port !== undefined && port !== DEFAULT_HTTPS_PORT) return null;
  return (match[1] ?? '').toLowerCase();
}

export function paymentHosts(sandbox: boolean, threeDsHosts: readonly string[] = THREE_DS_HOSTS): readonly string[] {
  const extra = threeDsHosts.map((host) => host.toLowerCase()).filter((host) => DNS_NAME.test(host));
  return [...PRODUCTION_HOSTS, ...(sandbox ? SANDBOX_HOSTS : []), ...extra];
}

/**
 * Is `url` a page we may open as the payment WebView's TOP-LEVEL page? Hand-written parser on
 * purpose (the RN `URL` polyfill is incomplete and lenient). All of these must hold:
 * - a string of at most 2048 printable ASCII characters (no controls, spaces, backslashes, Unicode);
 * - scheme `https`;
 * - host is EXACTLY an allow-listed host (no userinfo, no trailing dot, no IDN/percent tricks);
 * - port absent or 443;
 * - no percent-encoded control characters.
 */
export function isAllowedPaymentUrl(url: unknown, options: PaymentUrlOptions = {}): url is string {
  const host = cleanHttpsHost(url);
  if (host === null) return false;
  return paymentHosts(options.sandbox ?? isPaymentSandbox(), options.threeDsHosts).includes(host);
}

/**
 * A page that may be framed inside the provider's page (3-D Secure / bank frames): any public https
 * host, still without userinfo, odd ports, control characters or IP literals.
 */
export function isSafeHttpsUrl(url: unknown): url is string {
  const host = cleanHttpsHost(url);
  return host !== null && DNS_NAME.test(host) && !NUMERIC_LAST_LABEL.test(host);
}

/** What the user is shown as "where am I": the host of an allowed page, never the URL. */
export function displayHost(url: unknown, options: PaymentUrlOptions = {}): string | null {
  return isAllowedPaymentUrl(url, options) ? cleanHttpsHost(url) : null;
}
