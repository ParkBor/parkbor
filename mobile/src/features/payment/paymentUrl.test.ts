import { afterEach, describe, expect, it } from 'vitest';

import { displayHost, isAllowedPaymentUrl, isSafeHttpsUrl, MAX_PAYMENT_URL_LENGTH, THREE_DS_HOSTS } from '@/features/payment/paymentUrl';
import { isPaymentSandbox, setPaymentSandbox } from '@/features/payment/paymentSandbox';

const PAYME = 'https://checkout.paycom.uz/bT01NjQ3O2FjLm9yZGVyX2lkPTEyMzthPTEyMDAwMDA=';
const CLICK =
  'https://my.click.uz/services/pay?service_id=1&merchant_id=2&amount=12000.00&transaction_param=e4d0c1de-1111-4222-8333-444455556666&return_url=habi%3A%2F%2Fpayment%2Fresult';
const SANDBOX = 'https://test.paycom.uz/bT01NjQ3O2E9MQ==';

afterEach(() => setPaymentSandbox(false));

describe('isAllowedPaymentUrl: accepted shapes', () => {
  it.each([PAYME, CLICK, 'https://checkout.paycom.uz', 'https://checkout.paycom.uz/', 'https://my.click.uz/services/pay#x'])(
    'accepts %s',
    (url) => {
      expect(isAllowedPaymentUrl(url)).toBe(true);
    },
  );

  it('accepts the explicit default https port', () => {
    expect(isAllowedPaymentUrl('https://checkout.paycom.uz:443/abc')).toBe(true);
  });

  it('compares the host case-insensitively (same host after normalisation)', () => {
    expect(isAllowedPaymentUrl('HTTPS://CHECKOUT.PAYCOM.UZ/abc')).toBe(true);
    expect(isAllowedPaymentUrl('https://My.Click.Uz/services/pay')).toBe(true);
  });
});

describe('isAllowedPaymentUrl: host attacks', () => {
  it.each([
    ['suffix on the allowed host', 'https://checkout.paycom.uz.evil.com/x'],
    ['allowed host as a path', 'https://evil.com/checkout.paycom.uz'],
    ['allowed host as a subdomain prefix', 'https://checkout.paycom.uz-evil.com/x'],
    ['allowed host inside userinfo', 'https://checkout.paycom.uz@evil.com/x'],
    ['userinfo with a password', 'https://user:pass@checkout.paycom.uz/x'],
    ['userinfo with only a user', 'https://user@checkout.paycom.uz/x'],
    ['empty userinfo', 'https://@checkout.paycom.uz/x'],
    ['trailing dot', 'https://checkout.paycom.uz./x'],
    ['leading dot', 'https://.checkout.paycom.uz/x'],
    ['unrelated subdomain', 'https://evil.checkout.paycom.uz/x'],
    ['sibling subdomain of the provider', 'https://www.paycom.uz/x'],
    ['bare registrable domain', 'https://paycom.uz/x'],
    ['click on another subdomain', 'https://evil.my.click.uz/x'],
    ['percent-encoded host', 'https://checkout%2epaycom.uz/x'],
    ['percent-encoded host (fully)', 'https://%63heckout.paycom.uz/x'],
    ['backslash after the host', 'https://evil.com\\@checkout.paycom.uz/x'],
    ['backslash in the path', 'https://checkout.paycom.uz\\evil.com/x'],
    ['cyrillic homograph', 'https://chеckout.paycom.uz/x'],
    ['punycode homograph', 'https://xn--chckout-c0a.paycom.uz/x'],
    ['fullwidth dot', 'https://checkout．paycom.uz/x'],
    ['IPv4 literal', 'https://185.234.113.1/x'],
    ['IPv6 literal', 'https://[::1]/x'],
    ['empty host', 'https:///x'],
    ['double slash before host', 'https:////checkout.paycom.uz/x'],
  ])('rejects %s', (_name, url) => {
    expect(isAllowedPaymentUrl(url)).toBe(false);
  });
});

describe('isAllowedPaymentUrl: ports', () => {
  it.each([
    'https://checkout.paycom.uz:8443/x',
    'https://checkout.paycom.uz:80/x',
    'https://checkout.paycom.uz:0443/x',
    'https://checkout.paycom.uz:4430/x',
    'https://checkout.paycom.uz:/x',
    'https://checkout.paycom.uz:443:443/x',
    'https://checkout.paycom.uz:abc/x',
  ])('rejects %s', (url) => {
    expect(isAllowedPaymentUrl(url)).toBe(false);
  });
});

describe('isAllowedPaymentUrl: schemes', () => {
  it.each([
    'http://checkout.paycom.uz/x',
    'javascript:alert(1)',
    'javascript://checkout.paycom.uz/%0Aalert(1)',
    'intent://checkout.paycom.uz/#Intent;scheme=https;end',
    'market://details?id=com.evil',
    'tel:+998901234567',
    'sms:+998901234567',
    'mailto:a@b.c',
    'data:text/html,<script>alert(1)</script>',
    'file:///data/data/uz.habi.app/x',
    'ftp://checkout.paycom.uz/x',
    'habi://payment/result',
    'about:blank',
    'blob:https://checkout.paycom.uz/x',
    '//checkout.paycom.uz/x',
    'checkout.paycom.uz/x',
    'https:checkout.paycom.uz/x',
    'https:/checkout.paycom.uz/x',
    ' https://checkout.paycom.uz/x',
    'https://checkout.paycom.uz/x ',
    'xhttps://checkout.paycom.uz/x',
  ])('rejects %s', (url) => {
    expect(isAllowedPaymentUrl(url)).toBe(false);
  });
});

describe('isAllowedPaymentUrl: control characters and size', () => {
  it.each([
    ['newline in the path', 'https://checkout.paycom.uz/a\nb'],
    ['carriage return', 'https://checkout.paycom.uz/a\rb'],
    ['tab', 'https://checkout.paycom.uz/a\tb'],
    ['NUL', 'https://checkout.paycom.uz/a\u0000b'],
    ['DEL', 'https://checkout.paycom.uz/a\u007Fb'],
    ['space in the query', 'https://my.click.uz/services/pay?a=b c'],
    ['control char in the query', 'https://my.click.uz/services/pay?a=\u0001'],
    ['control char before the host', 'https://\u0000checkout.paycom.uz/x'],
    ['encoded NUL', 'https://checkout.paycom.uz/a%00b'],
    ['encoded CR LF', 'https://checkout.paycom.uz/a%0d%0ab'],
    ['encoded DEL', 'https://checkout.paycom.uz/a%7fb'],
    ['unicode line separator', 'https://checkout.paycom.uz/a b'],
    ['non-ASCII in the path', 'https://checkout.paycom.uz/т'],
    ['zero-width space in the host', 'https://checkout​.paycom.uz/x'],
    ['backslash in the query', 'https://my.click.uz/services/pay?a=\\'],
  ])('rejects %s', (_name, url) => {
    expect(isAllowedPaymentUrl(url)).toBe(false);
  });

  it('rejects an empty string and whitespace', () => {
    expect(isAllowedPaymentUrl('')).toBe(false);
    expect(isAllowedPaymentUrl('   ')).toBe(false);
  });

  it('accepts a URL at the length limit and rejects one byte longer', () => {
    const prefix = 'https://checkout.paycom.uz/';
    const atLimit = prefix + 'a'.repeat(MAX_PAYMENT_URL_LENGTH - prefix.length);
    expect(atLimit).toHaveLength(MAX_PAYMENT_URL_LENGTH);
    expect(isAllowedPaymentUrl(atLimit)).toBe(true);
    expect(isAllowedPaymentUrl(`${atLimit}a`)).toBe(false);
  });

  it('a huge URL is refused by the length check before any parsing (no scan of the whole string)', () => {
    expect(isAllowedPaymentUrl(`https://checkout.paycom.uz/${'a'.repeat(1_000_000)}`)).toBe(false);
    expect(isAllowedPaymentUrl(`https://${'a.'.repeat(500_000)}evil.com`)).toBe(false);
  });

  it('a host made of many dots / hyphens is rejected (linear regex, bounded by the length limit)', () => {
    const nasty = `https://${'a-'.repeat(900)}.checkout.paycom.uz/x`;
    expect(nasty.length).toBeLessThanOrEqual(MAX_PAYMENT_URL_LENGTH);
    expect(isAllowedPaymentUrl(nasty)).toBe(false);
    expect(isSafeHttpsUrl(`https://${'a.'.repeat(900)}com/x`)).toBe(true);
    expect(isSafeHttpsUrl(`https://${'a-'.repeat(1000)}!.com/x`)).toBe(false);
  });
})

describe('isAllowedPaymentUrl: non-string input', () => {
  it.each([null, undefined, 0, 12, true, {}, [], ['https://checkout.paycom.uz/x'], new URL('https://checkout.paycom.uz/x')])(
    'rejects %o',
    (value) => {
      expect(isAllowedPaymentUrl(value)).toBe(false);
    },
  );
});

describe('sandbox host', () => {
  it('rejects test.paycom.uz by default (production behaviour)', () => {
    expect(isPaymentSandbox()).toBe(false);
    expect(isAllowedPaymentUrl(SANDBOX)).toBe(false);
    expect(isAllowedPaymentUrl(SANDBOX, { sandbox: false })).toBe(false);
  });

  it('accepts test.paycom.uz only when the sandbox is on', () => {
    expect(isAllowedPaymentUrl(SANDBOX, { sandbox: true })).toBe(true);
    setPaymentSandbox(true);
    expect(isAllowedPaymentUrl(SANDBOX)).toBe(true);
  });

  it('an explicit option overrides the global flag in both directions', () => {
    setPaymentSandbox(true);
    expect(isAllowedPaymentUrl(SANDBOX, { sandbox: false })).toBe(false);
    setPaymentSandbox(false);
    expect(isAllowedPaymentUrl(SANDBOX, { sandbox: true })).toBe(true);
  });

  it('keeps the production hosts allowed in the sandbox, and still blocks look-alikes', () => {
    expect(isAllowedPaymentUrl(PAYME, { sandbox: true })).toBe(true);
    expect(isAllowedPaymentUrl('https://test.paycom.uz.evil.com/x', { sandbox: true })).toBe(false);
    expect(isAllowedPaymentUrl('https://evil.test.paycom.uz/x', { sandbox: true })).toBe(false);
  });

  it('setPaymentSandbox only turns the sandbox on for a strict boolean true', () => {
    setPaymentSandbox('true' as unknown as boolean);
    expect(isPaymentSandbox()).toBe(false);
    setPaymentSandbox(true);
    expect(isPaymentSandbox()).toBe(true);
  });
});

describe('threeDsHosts (configuration point, empty by default)', () => {
  it('is empty until measured against the Payme / Click sandboxes', () => {
    expect(THREE_DS_HOSTS).toEqual([]);
  });

  it('an explicitly passed host is allowed for top-level navigation, exact match only', () => {
    const options = { sandbox: false, threeDsHosts: ['acs.bank.uz'] };
    expect(isAllowedPaymentUrl('https://acs.bank.uz/3ds', options)).toBe(true);
    expect(isAllowedPaymentUrl('https://acs.bank.uz.evil.com/3ds', options)).toBe(false);
    expect(isAllowedPaymentUrl('https://evil.acs.bank.uz/3ds', options)).toBe(false);
    expect(isAllowedPaymentUrl('https://acs.bank.uz/3ds')).toBe(false);
  });

  it('ignores malformed entries instead of widening the list', () => {
    const options = { sandbox: false, threeDsHosts: ['', '*', '.bank.uz', 'bank.uz/path', 'ACS.BANK.UZ'] };
    expect(isAllowedPaymentUrl('https://evil.com/x', options)).toBe(false);
    expect(isAllowedPaymentUrl('https://x.bank.uz/x', options)).toBe(false);
    expect(isAllowedPaymentUrl('https://acs.bank.uz/x', options)).toBe(true);
  });
});

describe('isSafeHttpsUrl (iframes: any public https host, still no tricks)', () => {
  it.each(['https://acs.bank.uz/3ds', 'https://a.b.c.example.com:443/x?y=1#z', 'HTTPS://ACS.BANK.UZ/'])('accepts %s', (url) => {
    expect(isSafeHttpsUrl(url)).toBe(true);
  });

  it.each([
    'http://acs.bank.uz/',
    'https://user@acs.bank.uz/',
    'https://user:pw@acs.bank.uz/',
    'https://acs.bank.uz:8443/',
    'https://127.0.0.1/',
    'https://10.0.0.1/x',
    'https://192.168.1.1:443/x',
    'https://2130706433/',
    'https://[::1]/',
    'https://localhost/',
    'https://acs.bank.uz./',
    'https://acs..bank.uz/',
    'https://-acs.bank.uz/',
    'https://acs.bank.uz\\evil/',
    'https://acs.bank.uz/\n',
    'https://ацс.bank.uz/',
    'https://acs%2ebank.uz/',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///x',
    '',
  ])('rejects %s', (url) => {
    expect(isSafeHttpsUrl(url)).toBe(false);
  });

  it('rejects non-strings and oversized input', () => {
    expect(isSafeHttpsUrl(undefined)).toBe(false);
    expect(isSafeHttpsUrl(`https://acs.bank.uz/${'a'.repeat(MAX_PAYMENT_URL_LENGTH)}`)).toBe(false);
  });
});

describe('displayHost (what the user sees in the header)', () => {
  it('is the lower-case host of an allowed page, never the URL', () => {
    expect(displayHost('https://CHECKOUT.paycom.uz/abc?secret=1')).toBe('checkout.paycom.uz');
    expect(displayHost('https://my.click.uz:443/services/pay?x=1')).toBe('my.click.uz');
  });

  it('is null for anything not allowed', () => {
    expect(displayHost('https://evil.com/')).toBeNull();
    expect(displayHost('habi://payment/result')).toBeNull();
    expect(displayHost(undefined)).toBeNull();
    expect(displayHost('https://test.paycom.uz/x')).toBeNull();
    expect(displayHost('https://test.paycom.uz/x', { sandbox: true })).toBe('test.paycom.uz');
  });
});
