import { describe, expect, it } from 'vitest';

import { isNonProductionApiUrl, isNonProductionChannel, isSandboxAllowed } from '@/features/payment/paymentSandbox';

const STAGING = 'https://staging-api.parkbor.uz/api/v1';
const PROD = 'https://api.parkbor.uz/api/v1';

describe('isNonProductionApiUrl', () => {
  it.each([
    'https://staging-api.parkbor.uz/api/v1',
    'https://api.staging.parkbor.uz/api/v1',
    'http://localhost:8000/api/v1',
    'http://127.0.0.1:8000/api/v1',
    'http://10.0.2.2:8000/api/v1',
    'HTTPS://STAGING-API.PARKBOR.UZ/api/v1',
  ])('%s is a development / staging API', (url) => {
    expect(isNonProductionApiUrl(url)).toBe(true);
  });

  it.each([
    PROD,
    'https://parkbor.uz/api',
    'https://api.parkbor.uz.evil.com/api/v1',
    'https://evil.com/staging',
    'https://evil.com/?h=staging-api.parkbor.uz',
    'https://notstaging-api.parkbor.uz/',
    'https://staging.evil@api.parkbor.uz/',
    '',
    'not a url',
    undefined,
    null,
    7,
  ])('%s is not', (url) => {
    expect(isNonProductionApiUrl(url)).toBe(false);
  });
});

describe('isNonProductionChannel', () => {
  it.each(['development', 'preview', 'staging', 'e2e', 'E2E', ' preview '])('%s is a test profile', (channel) => {
    expect(isNonProductionChannel(channel)).toBe(true);
  });

  it.each(['production', '', 'prod', 'previews', undefined, null, 5])('%s is not', (channel) => {
    expect(isNonProductionChannel(channel)).toBe(false);
  });
});

describe('isSandboxAllowed (two factors: a flag AND a non-production API)', () => {
  const base = { isDev: false, flag: true, apiUrl: STAGING, channel: 'preview' };

  it('is on in a dev client regardless of the rest', () => {
    expect(isSandboxAllowed({ isDev: true, flag: false, apiUrl: PROD, channel: '' })).toBe(true);
  });

  it('is on for a preview build with the flag and a staging API', () => {
    expect(isSandboxAllowed(base)).toBe(true);
    expect(isSandboxAllowed({ ...base, channel: '' })).toBe(true);
  });

  it('the flag alone is not enough: a production API keeps it off (OTA update with a stray flag, no build profile)', () => {
    expect(isSandboxAllowed({ ...base, channel: '', apiUrl: PROD })).toBe(false);
    expect(isSandboxAllowed({ ...base, channel: undefined, apiUrl: PROD })).toBe(false);
  });

  it('an explicit preview / development / e2e profile plus the flag allows it on ANY test host', () => {
    for (const channel of ['preview', 'development', 'e2e', 'e2e-ios-simulator', ' Preview ']) {
      expect(isSandboxAllowed({ ...base, channel, apiUrl: 'https://my-test-server.example.com/api/v1' }), channel).toBe(true);
    }
  });

  it('a non-production profile without the flag stays off', () => {
    expect(isSandboxAllowed({ ...base, flag: false, apiUrl: 'https://my-test-server.example.com/api/v1' })).toBe(false);
  });

  it('a staging API alone is not enough', () => {
    expect(isSandboxAllowed({ ...base, flag: false })).toBe(false);
    expect(isSandboxAllowed({ ...base, flag: undefined })).toBe(false);
    expect(isSandboxAllowed({ ...base, flag: 'true' })).toBe(false);
  });

  it('a production channel marker always wins', () => {
    expect(isSandboxAllowed({ ...base, channel: 'production' })).toBe(false);
    expect(isSandboxAllowed({ ...base, channel: 'PRODUCTION' })).toBe(false);
  });

  it('garbage inputs keep it off', () => {
    expect(isSandboxAllowed({ isDev: false, flag: true, apiUrl: undefined, channel: undefined })).toBe(false);
    expect(isSandboxAllowed({ isDev: 'yes' as unknown as boolean, flag: false, apiUrl: PROD, channel: '' })).toBe(false);
  });
});
