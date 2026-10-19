import { describe, expect, it } from 'vitest';

import {
  createNavigationGuard,
  decideNavigationState,
  decideStartLoad,
  isAllowedNavigation,
  isResultUrl,
  MAX_NAVIGATIONS,
} from '@/features/payment/webviewPolicy';

const TOP = { sandbox: false, isTopFrame: true } as const;
const FRAME = { sandbox: false, isTopFrame: false } as const;
const ANDROID = { sandbox: false } as const; // Android never reports isTopFrame: everything is a main-frame request

describe('isAllowedNavigation: top frame (strict allow-list)', () => {
  it.each([TOP, ANDROID])('allows provider pages (%o)', (options) => {
    expect(isAllowedNavigation('https://checkout.paycom.uz/abc', options)).toBe('allow');
    expect(isAllowedNavigation('https://my.click.uz/services/pay?x=1', options)).toBe('allow');
  });

  it.each([
    'http://checkout.paycom.uz/x',
    'https://evil.com/',
    'https://acs.bank.uz/3ds',
    'https://checkout.paycom.uz.evil.com/',
    'https://checkout.paycom.uz@evil.com/',
    'javascript:alert(1)',
    'intent://scan/#Intent;scheme=zxing;package=com.evil;end',
    'market://details?id=com.evil',
    'tel:+998901234567',
    'sms:+998901234567?body=x',
    'mailto:a@b.c',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'content://com.android.contacts/x',
    'ftp://checkout.paycom.uz/',
    'tg://resolve?domain=evil',
    'https://t.me/evil',
    'payme://pay',
    'click://pay',
    'about:blank',
    'about:srcdoc',
    'blob:https://checkout.paycom.uz/x',
    '',
  ])('blocks %s in the top frame', (url) => {
    expect(isAllowedNavigation(url, TOP)).toBe('block');
    expect(isAllowedNavigation(url, ANDROID)).toBe('block');
  });

  it('blocks non-string input', () => {
    expect(isAllowedNavigation(undefined, ANDROID)).toBe('block');
    expect(isAllowedNavigation(null, ANDROID)).toBe('block');
    expect(isAllowedNavigation(42, ANDROID)).toBe('block');
  });

  it('follows the sandbox flag for test.paycom.uz', () => {
    expect(isAllowedNavigation('https://test.paycom.uz/x', ANDROID)).toBe('block');
    expect(isAllowedNavigation('https://test.paycom.uz/x', { sandbox: true })).toBe('allow');
  });

  it('a configured 3-D Secure host is allowed at the top level, nothing else is widened', () => {
    const options = { ...TOP, threeDsHosts: ['acs.bank.uz'] };
    expect(isAllowedNavigation('https://acs.bank.uz/3ds', options)).toBe('allow');
    expect(isAllowedNavigation('https://acs.bank.uz.evil.com/3ds', options)).toBe('block');
    expect(isAllowedNavigation('https://other.bank.uz/3ds', options)).toBe('block');
  });
});

describe('isAllowedNavigation: result link', () => {
  it.each([TOP, ANDROID])('is the result signal in the top frame (%o)', (options) => {
    expect(isAllowedNavigation('parkbor://payment/result', options)).toBe('result');
    expect(isAllowedNavigation('parkbor://payment/result?status=ok&id=1', options)).toBe('result');
    expect(isAllowedNavigation('parkbor://payment/result#frag', options)).toBe('result');
    expect(isAllowedNavigation('PARKBOR://payment/result', options)).toBe('result');
  });

  it('is NEVER accepted from an iframe (a framed page must not be able to close the payment)', () => {
    expect(isAllowedNavigation('parkbor://payment/result', FRAME)).toBe('block');
    expect(isAllowedNavigation('parkbor://payment/result?id=1', FRAME)).toBe('block');
  });

  it.each([
    'parkbor://payment/result/extra',
    'parkbor://payment/resultx',
    'parkbor://payment/results',
    'parkbor://payment/',
    'parkbor://booking/e4d0c1de-1111-4222-8333-444455556666',
    'parkbor://payment/Result',
    'parkbor://evil/payment/result',
    'parkbor:payment/result',
    'parkbor://payment/result\nx',
    'parkbor://payment/result x',
    'parkbor://payment\\result',
    'habi://payment/result',
    'HABI://payment/result',
    'xparkbor://payment/result',
    'http://parkbor/payment/result',
  ])('blocks the look-alike deep link %s', (url) => {
    expect(isAllowedNavigation(url, TOP)).toBe('block');
  });
});

describe('isAllowedNavigation: sub-frames (iOS reports iframes, Android does not)', () => {
  it('allows about:blank only in a frame', () => {
    expect(isAllowedNavigation('about:blank', FRAME)).toBe('allow');
    expect(isAllowedNavigation('about:blank', TOP)).toBe('block');
    expect(isAllowedNavigation('about:blank', ANDROID)).toBe('block');
    expect(isAllowedNavigation('about:srcdoc', FRAME)).toBe('block');
  });

  it('allows a public https page in a frame (3-D Secure and bank pages are framed by the provider)', () => {
    expect(isAllowedNavigation('https://acs.bank.uz/3ds?x=1', FRAME)).toBe('allow');
    expect(isAllowedNavigation('https://checkout.paycom.uz/frame', FRAME)).toBe('allow');
  });

  it.each([
    'http://acs.bank.uz/',
    'https://user@acs.bank.uz/',
    'https://acs.bank.uz:8443/',
    'https://10.0.0.1/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://acs.bank.uz/\u0000',
    'https://acs.bank.uz\\evil/',
    'javascript:alert(1)',
    'intent://x#Intent;end',
    'tel:+998901234567',
    'data:text/html,x',
    'file:///x',
    'market://details?id=x',
    '',
  ])('still blocks %s in a frame', (url) => {
    expect(isAllowedNavigation(url, FRAME)).toBe('block');
  });

  it('the same URL is judged differently by frame: strict on top, lenient (but safe) in a frame', () => {
    const url = 'https://acs.bank.uz/3ds';
    expect(isAllowedNavigation(url, TOP)).toBe('block');
    expect(isAllowedNavigation(url, FRAME)).toBe('allow');
  });
});

describe('isResultUrl', () => {
  it('recognises only the exact result link', () => {
    expect(isResultUrl('parkbor://payment/result?x=1')).toBe(true);
    expect(isResultUrl('parkbor://payment/result/x')).toBe(false);
    expect(isResultUrl('https://checkout.paycom.uz/x')).toBe(false);
    expect(isResultUrl(undefined)).toBe(false);
  });

  it('refuses an oversized link', () => {
    expect(isResultUrl(`parkbor://payment/result?${'a'.repeat(5000)}`)).toBe(false);
  });
});

describe('createNavigationGuard (redirect budget and block counter)', () => {
  it('a refused page costs no budget', () => {
    const guard = createNavigationGuard({ sandbox: false, maxNavigations: 1 });
    expect(guard.check('https://evil.com/', true)).toBe('block');
    expect(guard.check('https://checkout.paycom.uz/a', true)).toBe('allow');
    expect(guard.check('https://checkout.paycom.uz/b', true)).toBe('block');
  });

  it('blocks further pages once the budget is spent, but the result link still gets through', () => {
    const guard = createNavigationGuard({ sandbox: false, maxNavigations: 3 });
    expect(guard.check('https://checkout.paycom.uz/1')).toBe('allow');
    expect(guard.check('https://checkout.paycom.uz/2')).toBe('allow');
    expect(guard.check('https://my.click.uz/3')).toBe('allow');
    expect(guard.check('https://checkout.paycom.uz/4')).toBe('block');
    expect(guard.check('parkbor://payment/result')).toBe('result');
  });

  it('the default budget is exactly MAX_NAVIGATIONS page loads', () => {
    const guard = createNavigationGuard({ sandbox: false });
    for (let i = 0; i < MAX_NAVIGATIONS; i += 1) expect(guard.check('https://my.click.uz/x')).toBe('allow');
    expect(guard.check('https://my.click.uz/x')).toBe('block');
  });

  it('frames are not charged to the budget', () => {
    const guard = createNavigationGuard({ sandbox: false, maxNavigations: 1 });
    expect(guard.check('about:blank', false)).toBe('allow');
    expect(guard.check('https://acs.bank.uz/3ds', false)).toBe('allow');
    expect(guard.check('https://checkout.paycom.uz/a', true)).toBe('allow');
  });

  it('counts blocked top-level navigations (never their URLs)', () => {
    const guard = createNavigationGuard({ sandbox: false });
    guard.check('https://acs.bank.uz/3ds', true);
    guard.check('intent://x#Intent;end');
    guard.check('https://evil.com/', false);
    expect(guard.blocked()).toBe(2);
  });

  it('reset() starts a fresh budget and counters (a manual retry)', () => {
    const guard = createNavigationGuard({ sandbox: false, maxNavigations: 1 });
    guard.check('https://my.click.uz/x');
    guard.check('https://evil.com/');
    expect(guard.check('https://my.click.uz/y')).toBe('block');
    guard.reset();
    expect(guard.blocked()).toBe(0);
    expect(guard.check('https://my.click.uz/y')).toBe('allow');
  });

  it('passes a configured 3-D Secure host through', () => {
    const guard = createNavigationGuard({ sandbox: false, threeDsHosts: ['acs.bank.uz'] });
    expect(guard.check('https://acs.bank.uz/3ds', true)).toBe('allow');
  });
});

describe('decideStartLoad (the onShouldStartLoadWithRequest answer)', () => {
  const guard = () => createNavigationGuard({ sandbox: false });

  it('lets an allowed page start, silently', () => {
    expect(decideStartLoad(guard(), { url: 'https://my.click.uz/x', isTopFrame: true })).toEqual({ shouldStart: true, effect: 'none' });
  });

  it('stops the result link and reports it (top frame / Android)', () => {
    expect(decideStartLoad(guard(), { url: 'parkbor://payment/result' })).toEqual({ shouldStart: false, effect: 'result' });
    expect(decideStartLoad(guard(), { url: 'parkbor://payment/result', isTopFrame: true })).toEqual({ shouldStart: false, effect: 'result' });
  });

  it('a result link from an iframe is dropped WITHOUT closing the payment', () => {
    expect(decideStartLoad(guard(), { url: 'parkbor://payment/result', isTopFrame: false })).toEqual({ shouldStart: false, effect: 'none' });
  });

  it('a blocked TOP-level navigation is reported so the user is told (no silent dead end)', () => {
    expect(decideStartLoad(guard(), { url: 'https://acs.bank.uz/3ds', isTopFrame: true })).toEqual({ shouldStart: false, effect: 'blockedTop' });
    expect(decideStartLoad(guard(), { url: 'intent://x#Intent;end' })).toEqual({ shouldStart: false, effect: 'blockedTop' });
  });

  it('a blocked frame request is dropped quietly (the page stays usable)', () => {
    expect(decideStartLoad(guard(), { url: 'tel:+998901234567', isTopFrame: false })).toEqual({ shouldStart: false, effect: 'none' });
  });

  it('a spent redirect budget on the top level is reported like any other block', () => {
    const tight = createNavigationGuard({ sandbox: false, maxNavigations: 1 });
    decideStartLoad(tight, { url: 'https://my.click.uz/1', isTopFrame: true });
    expect(decideStartLoad(tight, { url: 'https://my.click.uz/2', isTopFrame: true })).toEqual({ shouldStart: false, effect: 'blockedTop' });
  });
});

describe('decideNavigationState (second line of defence, Android may load before the JS answer)', () => {
  it('ignores empty / about:blank / allowed pages', () => {
    expect(decideNavigationState('', { sandbox: false })).toBe('ignore');
    expect(decideNavigationState('about:blank', { sandbox: false })).toBe('ignore');
    expect(decideNavigationState(undefined, { sandbox: false })).toBe('ignore');
    expect(decideNavigationState('https://checkout.paycom.uz/x', { sandbox: false })).toBe('ignore');
  });

  it('a late result link still ends the payment (also when the native side already navigated)', () => {
    expect(decideNavigationState('parkbor://payment/result?id=1', { sandbox: false })).toBe('result');
  });

  it('a page outside the allow-list is a violation', () => {
    expect(decideNavigationState('https://evil.com/', { sandbox: false })).toBe('violation');
    expect(decideNavigationState('intent://x#Intent;end', { sandbox: false })).toBe('violation');
    expect(decideNavigationState('https://acs.bank.uz/3ds', { sandbox: false })).toBe('violation');
    expect(decideNavigationState('https://acs.bank.uz/3ds', { sandbox: false, threeDsHosts: ['acs.bank.uz'] })).toBe('ignore');
  });
});
