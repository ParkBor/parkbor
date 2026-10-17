import { describe, expect, it } from 'vitest';

import {
  classifyLoadError,
  errorMessageKey,
  initialWebViewState,
  reduceWebView,
  type WebViewEvent,
} from '@/features/payment/webviewState';

const run = (events: WebViewEvent[]) => events.reduce(reduceWebView, initialWebViewState());

describe('reduceWebView', () => {
  it('starts loading with nothing counted', () => {
    expect(initialWebViewState()).toEqual({ phase: 'loading', error: null, attempt: 0, navigations: 0, blockedCount: 0 });
  });

  it('every navigation counts, so the load watchdog can be re-armed per page', () => {
    const state = run([{ type: 'loadStart' }, { type: 'loadEnd' }, { type: 'loadStart' }]);
    expect(state.navigations).toBe(2);
    expect(state.phase).toBe('loading');
  });

  it('a blocked top-level navigation is counted without leaving the page', () => {
    const state = run([{ type: 'loadEnd' }, { type: 'blocked' }, { type: 'blocked' }]);
    expect(state).toMatchObject({ phase: 'ready', error: null, blockedCount: 2 });
  });

  it('a successful page load clears nothing about earlier blocks until the user retries', () => {
    expect(run([{ type: 'blocked' }, { type: 'loadEnd' }]).blockedCount).toBe(1);
  });

  it('load end -> ready', () => {
    expect(run([{ type: 'loadEnd' }]).phase).toBe('ready');
  });

  it('a new navigation shows loading again', () => {
    expect(run([{ type: 'loadEnd' }, { type: 'loadStart' }]).phase).toBe('loading');
  });

  it('timeout while loading -> error:timeout', () => {
    expect(run([{ type: 'timeout' }])).toMatchObject({ phase: 'error', error: 'timeout' });
  });

  it('a late timeout after the page loaded is ignored', () => {
    expect(run([{ type: 'loadEnd' }, { type: 'timeout' }]).phase).toBe('ready');
  });

  it('errors stick: a later loadEnd / loadStart does not hide them', () => {
    const failed = run([{ type: 'error', kind: 'ssl' }]);
    expect(failed).toMatchObject({ phase: 'error', error: 'ssl' });
    expect(reduceWebView(failed, { type: 'loadEnd' })).toBe(failed);
    expect(reduceWebView(failed, { type: 'loadStart' })).toBe(failed);
    expect(reduceWebView(failed, { type: 'timeout' })).toBe(failed);
  });

  it('the first error wins', () => {
    const failed = run([{ type: 'error', kind: 'offline' }, { type: 'error', kind: 'ssl' }]);
    expect(failed.error).toBe('offline');
  });

  it('HTTP 4xx / 5xx on the page -> error:http', () => {
    expect(run([{ type: 'httpError', statusCode: 404 }])).toMatchObject({ phase: 'error', error: 'http' });
    expect(run([{ type: 'httpError', statusCode: 503 }])).toMatchObject({ phase: 'error', error: 'http' });
  });

  it('a status below 400 is not an error', () => {
    expect(run([{ type: 'httpError', statusCode: 304 }]).phase).toBe('loading');
  });

  it('renderer crash -> error:process', () => {
    expect(run([{ type: 'loadEnd' }, { type: 'error', kind: 'process' }])).toMatchObject({ phase: 'error', error: 'process' });
  });

  it('retry also forgets earlier blocks', () => {
    expect(run([{ type: 'blocked' }, { type: 'retry' }]).blockedCount).toBe(0);
  });

  it('retry returns to loading with a new attempt number (forces a remount)', () => {
    const retried = run([{ type: 'error', kind: 'offline' }, { type: 'retry' }]);
    expect(retried).toEqual({ phase: 'loading', error: null, attempt: 1, navigations: 0, blockedCount: 0 });
    expect(reduceWebView(retried, { type: 'retry' }).attempt).toBe(2);
  });

  it('does not mutate the previous state', () => {
    const before = initialWebViewState();
    reduceWebView(before, { type: 'loadEnd' });
    expect(before).toEqual({ phase: 'loading', error: null, attempt: 0, navigations: 0, blockedCount: 0 });
  });
});

describe('classifyLoadError', () => {
  it.each([
    [{ description: 'net::ERR_CERT_AUTHORITY_INVALID' }, 'ssl'],
    [{ description: 'net::ERR_SSL_PROTOCOL_ERROR' }, 'ssl'],
    [{ description: 'The certificate for this server is invalid.' }, 'ssl'],
    [{ code: -1202, description: 'The certificate for this server is invalid' }, 'ssl'],
    [{ description: 'SSL error' }, 'ssl'],
    [{ description: 'net::ERR_INTERNET_DISCONNECTED' }, 'offline'],
    [{ description: 'net::ERR_NAME_NOT_RESOLVED' }, 'offline'],
    [{ code: -1009, description: 'The Internet connection appears to be offline.' }, 'offline'],
    [{ description: 'net::ERR_TIMED_OUT' }, 'timeout'],
    [{ code: -1001, description: 'The request timed out.' }, 'timeout'],
    [{ description: 'something else entirely' }, 'load'],
    [{}, 'load'],
    [null, 'load'],
    [undefined, 'load'],
    ['oops', 'load'],
  ])('%o -> %s', (event, expected) => {
    expect(classifyLoadError(event)).toBe(expected);
  });

  it('uses the offline hint from the app when the description is empty', () => {
    expect(classifyLoadError({}, true)).toBe('offline');
  });

  it('never returns or exposes the raw description / URL', () => {
    const kind = classifyLoadError({ description: 'failed for https://checkout.paycom.uz/secret', url: 'https://checkout.paycom.uz/secret' });
    expect(kind).toBe('load');
  });
});

describe('errorMessageKey', () => {
  it('has a specific i18n key for every kind', () => {
    for (const kind of ['load', 'offline', 'ssl', 'timeout', 'http', 'process'] as const) {
      expect(errorMessageKey(kind)).toBe(`payment.webview.error.${kind}`);
    }
  });
});
