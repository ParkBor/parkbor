export const PAYMENT_PROVIDERS = ['payme', 'click'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/** Server `payment_provider`: "payme" | "click" | "" (bookings older than payments). Anything else -> null. */
export function parsePaymentProvider(value: unknown): PaymentProvider | null {
  return PAYMENT_PROVIDERS.find((provider) => provider === value) ?? null;
}

/** Backend 422 code: the chosen (or default) provider is not configured on the server. */
const UNAVAILABLE_CODE = 'payment_provider_unavailable';

export interface ProviderChoice {
  /** null = send nothing, the server uses its default (PAYMENTS_DEFAULT_PROVIDER). */
  readonly selected: PaymentProvider | null;
  /** Providers the server refused as unavailable in this session. */
  readonly unavailable: readonly PaymentProvider[];
  /** The server default turned out to be unavailable: an explicit choice is required. */
  readonly isDefaultUnavailable: boolean;
  /** Provider of the last booking made without a choice: the likely server default (display hint only). */
  readonly serverDefault: PaymentProvider | null;
}

export function initialProviderChoice(): ProviderChoice {
  return { selected: null, unavailable: [], isDefaultUnavailable: false, serverDefault: null };
}

/** Providers worth showing: empty means "hide the picker" (nothing can be paid with). */
export function visibleProviders(state: ProviderChoice): readonly PaymentProvider[] {
  return PAYMENT_PROVIDERS.filter((provider) => !state.unavailable.includes(provider));
}

/** Tapping the chosen chip again returns to the server default. Unavailable providers cannot be chosen. */
export function selectProvider(state: ProviderChoice, provider: PaymentProvider): ProviderChoice {
  if (state.unavailable.includes(provider)) return state;
  return { ...state, selected: state.selected === provider ? null : provider };
}

/** The value for `POST /bookings` (`payment_provider`); null = omit. */
export function payloadProvider(state: ProviderChoice): PaymentProvider | null {
  return state.selected;
}

/** No provider left, or the default is known broken and nothing else was chosen. */
export function canSubmitWithProvider(state: ProviderChoice): boolean {
  if (visibleProviders(state).length === 0) return false;
  return !(state.selected === null && state.isDefaultUnavailable);
}

/**
 * Learns from a failed `POST /bookings`. `sent` is the provider that request carried (null = default).
 * Any other failure leaves the state untouched (same object).
 */
export function learnFromBookingFailure(
  state: ProviderChoice,
  failure: { code?: string | null } | null,
  sent: PaymentProvider | null,
): ProviderChoice {
  if (failure === null || failure.code !== UNAVAILABLE_CODE) return state;
  if (sent === null) return { ...state, isDefaultUnavailable: true };
  const unavailable = state.unavailable.includes(sent) ? state.unavailable : [...state.unavailable, sent];
  return { ...state, unavailable, selected: state.selected === sent ? null : state.selected };
}

/** A booking was created. If no choice was sent, its provider is the server default. */
export function learnServerDefault(state: ProviderChoice, provider: PaymentProvider | null, wasDefault = true): ProviderChoice {
  if (!wasDefault || provider === null) return state;
  return { ...state, serverDefault: provider, isDefaultUnavailable: false };
}
