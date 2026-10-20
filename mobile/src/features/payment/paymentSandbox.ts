/**
 * Whether the provider TEST host (test.paycom.uz) is acceptable. Off by default = production
 * behaviour: a release build can never open a sandbox page, even if the server sent such a URL.
 * Turned on once at start-up by `paymentEnv.ts` (dev client / preview build only).
 */
let sandbox = false;

/** Only a strict boolean `true` enables it; anything else keeps the safe default. */
export function setPaymentSandbox(value: boolean): void {
  sandbox = value === true;
}

export function isPaymentSandbox(): boolean {
  return sandbox;
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '10.0.2.2']);
const API_HOST = /^https?:\/\/([^/:?#@\s]+)(?::\d{1,5})?(?:[/?#]|$)/i;

/**
 * Is the API a development / staging server (localhost, the Android emulator host, or a name with a
 * `staging` / `staging-...` label)? A production API is never one.
 */
export function isNonProductionApiUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const host = API_HOST.exec(url)?.[1]?.toLowerCase();
  if (host === undefined) return false;
  return LOCAL_HOSTS.has(host) || host.split('.').some((label) => label === 'staging' || label.startsWith('staging-'));
}

/** EAS build profiles that are never shipped to a store (see eas.json). */
const NON_PRODUCTION_CHANNELS: ReadonlySet<string> = new Set(['development', 'preview', 'staging', 'e2e', 'e2e-ios-simulator']);

export function isNonProductionChannel(channel: unknown): boolean {
  return typeof channel === 'string' && NON_PRODUCTION_CHANNELS.has(channel.trim().toLowerCase());
}

export interface SandboxInputs {
  /** React Native `__DEV__`: a dev client. */
  isDev: boolean;
  /** `extra.paymentSandbox` from app.config.ts. */
  flag: unknown;
  /** `extra.apiUrl`. */
  apiUrl: unknown;
  /** `extra.buildChannel` (APP_ENV / EAS_BUILD_PROFILE at build or update time). */
  channel: unknown;
}

/**
 * The Payme test host needs TWO independent signals in a release bundle: the build flag AND either an
 * explicit non-production build profile or a non-production API URL. This closes the OTA hole: `eas update` / `expo export` carry no
 * production marker, so a stray flag alone must not open the sandbox on a production API. A
 * production channel marker always wins.
 */
export function isSandboxAllowed(inputs: SandboxInputs): boolean {
  if (inputs.isDev === true) return true;
  if (typeof inputs.channel === 'string' && inputs.channel.toLowerCase() === 'production') return false;
  if (inputs.flag !== true) return false;
  // An explicit non-production build profile (EAS_BUILD_PROFILE / APP_ENV) is a second factor on its own: a preview
  // APK may point at any test server. An OTA update carries no profile, so it still needs the host rule.
  return isNonProductionChannel(inputs.channel) || isNonProductionApiUrl(inputs.apiUrl);
}
