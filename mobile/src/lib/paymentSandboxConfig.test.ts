import { describe, expect, it } from 'vitest';

import { resolvePaymentSandbox } from '../../config/paymentSandbox';

describe('resolvePaymentSandbox (app.config.ts)', () => {
  it('is off unless explicitly enabled', () => {
    expect(resolvePaymentSandbox(undefined, false)).toBe(false);
    expect(resolvePaymentSandbox('', false)).toBe(false);
    expect(resolvePaymentSandbox('false', false)).toBe(false);
    expect(resolvePaymentSandbox('1', false)).toBe(false);
    expect(resolvePaymentSandbox('yes', false)).toBe(false);
  });

  it('is on for "true" outside production (preview / development builds)', () => {
    expect(resolvePaymentSandbox('true', false)).toBe(true);
    expect(resolvePaymentSandbox(' TRUE ', false)).toBe(true);
  });

  it('a production build never carries the sandbox', () => {
    expect(resolvePaymentSandbox(undefined, true)).toBe(false);
    expect(resolvePaymentSandbox('false', true)).toBe(false);
  });

  it('a production build with the sandbox flag set FAILS loudly', () => {
    expect(() => resolvePaymentSandbox('true', true)).toThrow(/EXPO_PUBLIC_PAYMENT_SANDBOX/);
  });
});
