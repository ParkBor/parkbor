import { describe, expect, it, vi } from 'vitest';

import {
  buildNavUrl,
  detectAvailableApps,
  type NavApp,
} from '@/features/route/externalNav';

const dest = { lat: 41.3265, lng: 69.2285 };

describe('buildNavUrl', () => {
  it('builds a Yandex Navigator link with destination only', () => {
    expect(buildNavUrl('yandex', dest, 'android')).toBe('yandexnavi://build_route_on_map?lat_to=41.326500&lon_to=69.228500');
  });

  it('builds Google Maps links per platform', () => {
    expect(buildNavUrl('google', dest, 'android')).toBe('google.navigation:q=41.326500,69.228500&mode=d');
    expect(buildNavUrl('google', dest, 'ios')).toBe('comgooglemaps://?daddr=41.326500,69.228500&directionsmode=driving');
  });

  it('builds an Apple Maps link on iOS only', () => {
    expect(buildNavUrl('apple', dest, 'ios')).toBe('https://maps.apple.com/?daddr=41.326500,69.228500&dirflg=d');
    expect(buildNavUrl('apple', dest, 'android')).toBeNull();
  });

  it('handles negative coordinates and tiny values without exponent notation', () => {
    const url = buildNavUrl('yandex', { lat: -0.000001, lng: -179.5 }, 'ios');
    expect(url).toBe('yandexnavi://build_route_on_map?lat_to=-0.000001&lon_to=-179.500000');
    expect(url).not.toMatch(/e-/);
  });

  it.each([
    ['NaN', { lat: Number.NaN, lng: 69 }],
    ['Infinity', { lat: 41, lng: Number.POSITIVE_INFINITY }],
    ['lat out of range', { lat: 90.1, lng: 69 }],
    ['lng out of range', { lat: 41, lng: 181 }],
    ['string smuggled in', { lat: '41&evil=1' as unknown as number, lng: 69 }],
  ])('rejects %s', (_label, bad) => {
    for (const app of ['yandex', 'google', 'apple', 'geo'] as NavApp[]) {
      expect(buildNavUrl(app, bad, 'android')).toBeNull();
      expect(buildNavUrl(app, bad, 'ios')).toBeNull();
    }
  });

  it("is exactly scheme + fixed destination coordinates - nothing else is ever appended", () => {
    // A fixed-point number: sign, digits, exactly 6 decimals (no exponent, no extra text).
    const n = String.raw`-?\d{1,3}\.\d{6}`;
    const patterns: Record<NavApp, RegExp> = {
      yandex: new RegExp(String.raw`^yandexnavi://build_route_on_map\?lat_to=${n}&lon_to=${n}$`),
      google: new RegExp(String.raw`^comgooglemaps://\?daddr=${n},${n}&directionsmode=driving$`),
      apple: new RegExp(String.raw`^https://maps\.apple\.com/\?daddr=${n},${n}&dirflg=d$`),
      geo: new RegExp(String.raw`^geo:${n},${n}\?q=${n},${n}$`),
    };
    for (const app of ['yandex', 'google', 'apple'] as NavApp[]) {
      expect(buildNavUrl(app, dest, 'ios')).toMatch(patterns[app]);
    }
    expect(buildNavUrl('google', dest, 'android')).toMatch(
      new RegExp(String.raw`^google\.navigation:q=${n},${n}&mode=d$`),
    );
    expect(buildNavUrl('geo', dest, 'android')).toMatch(patterns.geo);
  });

  it("geo: is the Android last resort only", () => {
    expect(buildNavUrl("geo", dest, "ios")).toBeNull();
    expect(buildNavUrl("geo", { lat: Number.NaN, lng: 1 }, "android")).toBeNull();
  });
});

describe('detectAvailableApps', () => {
  it('lists installed apps in priority order using canOpenURL on a probe scheme', async () => {
    const canOpen = vi.fn(async (url: string) => url.startsWith('yandexnavi:') || url.startsWith('comgooglemaps:'));
    const apps = await detectAvailableApps('ios', canOpen);
    expect(apps).toEqual(['yandex', 'google', 'apple']);
    expect(canOpen).toHaveBeenCalledWith('yandexnavi://');
    expect(canOpen).toHaveBeenCalledWith('comgooglemaps://');
  });

  it('omits missing apps; Apple Maps is always there on iOS', async () => {
    expect(await detectAvailableApps('ios', async () => false)).toEqual(['apple']);
  });

  it('returns only the installed ones on Android', async () => {
    const apps = await detectAvailableApps('android', async (url) => url.startsWith('google.navigation:'));
    expect(apps).toEqual(['google']);
    expect(await detectAvailableApps('android', async () => false)).toEqual([]);
  });

  it('treats a canOpenURL rejection as "not installed"', async () => {
    const canOpen = async (url: string): Promise<boolean> => {
      if (url.startsWith('yandexnavi:')) throw new Error('boom');
      return true;
    };
    expect(await detectAvailableApps('android', canOpen)).toEqual(['google']);
  });
});
