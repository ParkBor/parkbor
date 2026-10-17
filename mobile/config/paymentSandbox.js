// Plain CommonJS on purpose (see mapsKey.js): app.config.ts runs in Node at config time.
// Unit tested from src/lib/paymentSandboxConfig.test.ts.

/**
 * Whether the build may open the Payme TEST checkout (test.paycom.uz). Opt-in through
 * EXPO_PUBLIC_PAYMENT_SANDBOX=true for development / preview builds. A production build must
 * never carry it: setting the flag there fails the build instead of silently shipping a sandbox.
 *
 * @param {string | undefined} value
 * @param {boolean} isProduction
 * @returns {boolean}
 */
function resolvePaymentSandbox(value, isProduction) {
  const isRequested = value !== undefined && value.trim().toLowerCase() === 'true';
  if (isRequested && isProduction) {
    throw new Error('EXPO_PUBLIC_PAYMENT_SANDBOX must not be enabled for production builds');
  }
  return isRequested;
}

module.exports = { resolvePaymentSandbox };
