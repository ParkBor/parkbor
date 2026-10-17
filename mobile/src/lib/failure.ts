import { ContractError } from '@/lib/contract';
import { parseApiError } from '@/lib/errors';

/**
 * What a caller may do after a failed write:
 * - `same_key`: transient (network, 5xx, lock timeout, throttle) - the same request may be repeated,
 *   with the SAME Idempotency-Key, so the server can deduplicate;
 * - `new_key`: the key itself is the problem (conflict with another body, malformed) - generate a new one;
 * - `edit`: the user must change something first (period, vehicle, ...);
 * - `none`: repeating cannot help.
 */
export type RetryAdvice = 'same_key' | 'new_key' | 'edit' | 'none';

export interface Failure {
  /** i18n key of a user-facing message. Never backend `detail` text. */
  key: string;
  retry: RetryAdvice;
  code: string | null;
  status: number | null;
}

export interface CodeRule {
  retry: RetryAdvice;
}

export type CodeRules = Readonly<Record<string, CodeRule>>;

/**
 * Classifies a failed request. A known machine `code` wins (`<prefix>.<code>`), then the status
 * class falls back to generic `failure.*` messages. Unknown codes never surface backend text.
 */
export function describeFailure(error: unknown, rules: CodeRules, prefix: string): Failure {
  if (error instanceof ContractError) {
    return { key: 'failure.contract', retry: 'none', code: null, status: null };
  }
  const info = parseApiError(error);
  const status = info.status ?? null;
  const code = info.code ?? null;
  if (info.kind === 'network') return { key: 'failure.network', retry: 'same_key', code: null, status };

  const rule = code !== null && Object.hasOwn(rules, code) ? rules[code] : undefined;
  if (rule && code !== null) return { key: `${prefix}.${code}`, retry: rule.retry, code, status };

  const generic = (key: string, retry: RetryAdvice): Failure => ({ key, retry, code, status });
  if (info.kind === 'throttled') return generic('failure.throttled', 'same_key');
  if (status === 503) return generic('failure.unavailable', 'same_key');
  if (status !== null && status >= 500) return generic('failure.server', 'same_key');
  if (status === 404) return generic('failure.notFound', 'none');
  if (status === 400) return generic('failure.badRequest', 'edit');
  return generic('failure.generic', 'none');
}
