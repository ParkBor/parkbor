import { isAllowedPaymentUrl, isSafeHttpsUrl, MAX_PAYMENT_URL_LENGTH } from '@/features/payment/paymentUrl';

/**
 * What the payment WebView does with a navigation request:
 * - `allow`  load it;
 * - `result` the provider sent the user back (`habi://payment/result`): do NOT load it, close the
 *            WebView and re-fetch the booking from the server;
 * - `block`  drop it. Nothing is ever handed to the OS (no intent:, market:, tel:, sms:, other apps).
 *
 * Top frame (iOS `isTopFrame !== false`, and EVERYTHING on Android, which never reports frames) is
 * judged against the strict host allow-list. iOS also asks about iframes (`isTopFrame === false`);
 * a framed page may be any public https page (3-D Secure / bank frames), but can never end the payment.
 */
export type NavigationDecision = 'allow' | 'block' | 'result';

export interface NavigationOptions {
  sandbox?: boolean;
  /** iOS reports iframes with `isTopFrame: false`; Android omits it (= top frame). */
  isTopFrame?: boolean;
  /** Extra exact hosts for top-level 3-D Secure redirects; empty by default (see `THREE_DS_HOSTS`). */
  threeDsHosts?: readonly string[];
}

/** Providers redirect at most a handful of times; a long chain is an open-redirect loop or an attack. */
export const MAX_NAVIGATIONS = 30;

const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;
/** The only link we accept as "back from the provider": exact path, optional query / fragment. */
const RESULT_LINK = /^[hH][aA][bB][iI]:\/\/payment\/result(?:[?#].*)?$/;
const EMPTY_FRAME = 'about:blank';

/** `habi://payment/result[?query][#fragment]` and nothing that merely starts like it. */
export function isResultUrl(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    url.length <= MAX_PAYMENT_URL_LENGTH &&
    PRINTABLE_ASCII.test(url) &&
    !url.includes('\\') &&
    RESULT_LINK.test(url)
  );
}

export function isAllowedNavigation(url: unknown, options: NavigationOptions = {}): NavigationDecision {
  const isTopFrame = options.isTopFrame !== false;
  if (isResultUrl(url)) return isTopFrame ? 'result' : 'block';
  if (url === EMPTY_FRAME) return isTopFrame ? 'block' : 'allow';
  if (isTopFrame) {
    return isAllowedPaymentUrl(url, { sandbox: options.sandbox, threeDsHosts: options.threeDsHosts }) ? 'allow' : 'block';
  }
  return isSafeHttpsUrl(url) ? 'allow' : 'block';
}

export interface NavigationGuard {
  /** Decision for one request; counts allowed top-level page loads against the redirect budget. */
  check(url: unknown, isTopFrame?: boolean): NavigationDecision;
  /** Top-level navigations that were blocked (the user is told; the URLs are never kept). */
  blocked(): number;
  reset(): void;
}

export interface NavigationGuardOptions {
  sandbox?: boolean;
  maxNavigations?: number;
  threeDsHosts?: readonly string[];
}

/** `isAllowedNavigation` plus a redirect budget. The result link is never charged: leaving must always work. */
export function createNavigationGuard(options: NavigationGuardOptions = {}): NavigationGuard {
  const max = options.maxNavigations ?? MAX_NAVIGATIONS;
  let used = 0;
  let blockedTop = 0;
  return {
    check(url, isTopFrame) {
      const decision = isAllowedNavigation(url, { sandbox: options.sandbox, threeDsHosts: options.threeDsHosts, isTopFrame });
      const isTop = isTopFrame !== false;
      if (decision === 'allow' && isTop) {
        if (used >= max) {
          blockedTop += 1;
          return 'block';
        }
        used += 1;
      }
      if (decision === 'block' && isTop) blockedTop += 1;
      return decision;
    },
    blocked: () => blockedTop,
    reset() {
      used = 0;
      blockedTop = 0;
    },
  };
}

export interface StartLoadRequest {
  url: unknown;
  isTopFrame?: boolean;
}

export interface StartLoadDecision {
  shouldStart: boolean;
  /** `result`: close the WebView; `blockedTop`: tell the user a page was refused; `none`: nothing to do. */
  effect: 'none' | 'result' | 'blockedTop';
}

/** The pure core of `onShouldStartLoadWithRequest`. */
export function decideStartLoad(guard: NavigationGuard, request: StartLoadRequest): StartLoadDecision {
  const decision = guard.check(request.url, request.isTopFrame);
  if (decision === 'allow') return { shouldStart: true, effect: 'none' };
  if (decision === 'result') return { shouldStart: false, effect: 'result' };
  return { shouldStart: false, effect: request.isTopFrame === false ? 'none' : 'blockedTop' };
}

/**
 * The pure core of the second line of defence (`onNavigationStateChange` / `onLoadStart`): on Android
 * the native side loads a page when the JS answer comes late, so what is actually loading is checked
 * again. `violation` = leave the page; `result` = the payment ended after all.
 */
export function decideNavigationState(
  url: unknown,
  options: Pick<NavigationOptions, 'sandbox' | 'threeDsHosts'>,
): 'ignore' | 'result' | 'violation' {
  if (typeof url !== 'string' || url === '' || url === EMPTY_FRAME) return 'ignore';
  const decision = isAllowedNavigation(url, { ...options, isTopFrame: true });
  if (decision === 'result') return 'result';
  return decision === 'block' ? 'violation' : 'ignore';
}
