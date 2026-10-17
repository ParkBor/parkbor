import { describe, expect, it } from 'vitest';

import {
  canSubmitWithProvider,
  initialProviderChoice,
  learnFromBookingFailure,
  learnServerDefault,
  parsePaymentProvider,
  payloadProvider,
  PAYMENT_PROVIDERS,
  selectProvider,
  visibleProviders,
} from '@/features/payment/providerChoice';

const unavailable = { code: 'payment_provider_unavailable' };

describe('parsePaymentProvider', () => {
  it('keeps the two known providers', () => {
    expect(parsePaymentProvider('payme')).toBe('payme');
    expect(parsePaymentProvider('click')).toBe('click');
  });

  it.each(['', 'PAYME', 'stripe', null, undefined, 3, {}])('maps %o to null', (value) => {
    expect(parsePaymentProvider(value)).toBeNull();
  });
});

describe('initial state', () => {
  it('offers both providers, nothing chosen (= the server default)', () => {
    const state = initialProviderChoice();
    expect(visibleProviders(state)).toEqual(PAYMENT_PROVIDERS);
    expect(payloadProvider(state)).toBeNull();
    expect(canSubmitWithProvider(state)).toBe(true);
    expect(state.serverDefault).toBeNull();
  });
});

describe('selectProvider', () => {
  it('chooses a provider', () => {
    expect(payloadProvider(selectProvider(initialProviderChoice(), 'click'))).toBe('click');
  });

  it('choosing the same one again goes back to the server default', () => {
    const chosen = selectProvider(initialProviderChoice(), 'click');
    expect(payloadProvider(selectProvider(chosen, 'click'))).toBeNull();
  });

  it('switching replaces the choice', () => {
    const state = selectProvider(selectProvider(initialProviderChoice(), 'click'), 'payme');
    expect(payloadProvider(state)).toBe('payme');
  });

  it('refuses a provider that is known to be unavailable', () => {
    const learned = learnFromBookingFailure(initialProviderChoice(), unavailable, 'payme');
    expect(payloadProvider(selectProvider(learned, 'payme'))).toBeNull();
  });

  it('does not mutate the previous state', () => {
    const before = initialProviderChoice();
    selectProvider(before, 'click');
    expect(before).toEqual(initialProviderChoice());
  });
});

describe('learnFromBookingFailure', () => {
  it('hides the provider the server called unavailable and resets the choice', () => {
    const chosen = selectProvider(initialProviderChoice(), 'click');
    const learned = learnFromBookingFailure(chosen, unavailable, 'click');
    expect(visibleProviders(learned)).toEqual(['payme']);
    expect(payloadProvider(learned)).toBeNull();
  });

  it('keeps a different, still working choice', () => {
    const chosen = selectProvider(initialProviderChoice(), 'click');
    const learned = learnFromBookingFailure(chosen, unavailable, 'payme');
    expect(payloadProvider(learned)).toBe('click');
  });

  it('when the server DEFAULT is unavailable, an explicit choice is required', () => {
    const learned = learnFromBookingFailure(initialProviderChoice(), unavailable, null);
    expect(learned.isDefaultUnavailable).toBe(true);
    expect(visibleProviders(learned)).toEqual(PAYMENT_PROVIDERS);
    expect(canSubmitWithProvider(learned)).toBe(false);
    expect(canSubmitWithProvider(selectProvider(learned, 'click'))).toBe(true);
  });

  it('when everything is unavailable the picker disappears and submitting is blocked', () => {
    let state = learnFromBookingFailure(initialProviderChoice(), unavailable, null);
    state = learnFromBookingFailure(selectProvider(state, 'click'), unavailable, 'click');
    state = learnFromBookingFailure(selectProvider(state, 'payme'), unavailable, 'payme');
    expect(visibleProviders(state)).toEqual([]);
    expect(canSubmitWithProvider(state)).toBe(false);
  });

  it('with both providers explicitly unavailable even a default send is pointless', () => {
    let state = learnFromBookingFailure(initialProviderChoice(), unavailable, 'click');
    state = learnFromBookingFailure(state, unavailable, 'payme');
    expect(canSubmitWithProvider(state)).toBe(false);
  });

  it.each([{ code: 'price_zero' }, { code: 'no_slot_available' }, { code: null }, {}])('ignores other failures %o', (failure) => {
    const state = selectProvider(initialProviderChoice(), 'click');
    expect(learnFromBookingFailure(state, failure, 'click')).toBe(state);
  });

  it('ignores a null failure', () => {
    const state = initialProviderChoice();
    expect(learnFromBookingFailure(state, null, null)).toBe(state);
  });
});

describe('learnServerDefault', () => {
  it('remembers the provider of a created booking as the likely server default (display hint only)', () => {
    const state = learnServerDefault(initialProviderChoice(), 'payme');
    expect(state.serverDefault).toBe('payme');
    expect(payloadProvider(state)).toBeNull();
  });

  it('only records a choice-free (default) booking as the default', () => {
    const chosen = selectProvider(initialProviderChoice(), 'click');
    expect(learnServerDefault(chosen, 'click', false).serverDefault).toBeNull();
  });

  it('ignores an unknown provider', () => {
    expect(learnServerDefault(initialProviderChoice(), null).serverDefault).toBeNull();
  });

  it('a successful booking clears the "default unavailable" belief', () => {
    const broken = learnFromBookingFailure(initialProviderChoice(), unavailable, null);
    expect(learnServerDefault(broken, 'payme').isDefaultUnavailable).toBe(false);
  });
});
