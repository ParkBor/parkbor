import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DARK_STYLE_URL,
  DEFAULT_LIGHT_STYLE_URL,
  OSM_ATTRIBUTION,
  attributionFor,
  resolveMapStyles,
  validateMapStyleUrl,
} from '@/features/map/mapStyle';

describe('validateMapStyleUrl', () => {
  it('accepts https style URLs, including a provider key in the query', () => {
    expect(validateMapStyleUrl('https://tiles.openfreemap.org/styles/liberty', false)).toBe('https://tiles.openfreemap.org/styles/liberty');
    expect(validateMapStyleUrl('https://api.maptiler.com/maps/streets-v2/style.json?key=abc123', false)).toBe(
      'https://api.maptiler.com/maps/streets-v2/style.json?key=abc123',
    );
    expect(validateMapStyleUrl('https://maps.example.uz:8443/styles/habi.json', false)).toBe('https://maps.example.uz:8443/styles/habi.json');
    expect(validateMapStyleUrl('  https://tiles.openfreemap.org/styles/dark  ', false)).toBe('https://tiles.openfreemap.org/styles/dark');
  });

  it('refuses plain http in release builds and for non-local hosts in dev', () => {
    expect(() => validateMapStyleUrl('http://tiles.openfreemap.org/styles/liberty', false)).toThrow(/https/);
    expect(() => validateMapStyleUrl('http://tiles.openfreemap.org/styles/liberty', true)).toThrow(/https/);
    expect(() => validateMapStyleUrl('http://localhost:8080/style.json', false)).toThrow(/https/);
  });

  it('allows http to a local style server in dev only', () => {
    for (const url of ['http://localhost:8080/style.json', 'http://127.0.0.1:8080/style.json', 'http://10.0.2.2:8080/style.json']) {
      expect(validateMapStyleUrl(url, true)).toBe(url);
    }
  });

  it.each([
    ['userinfo', 'https://user:pass@tiles.example.com/style.json'],
    ['userinfo without password', 'https://user@tiles.example.com/style.json'],
    ['fragment', 'https://tiles.example.com/style.json#x'],
    ['whitespace inside', 'https://tiles.example.com/sty le.json'],
    ['newline inside', 'https://tiles.example.com/sty\nle.json'],
    ['backslash', 'https://tiles.example.com\\evil.com/style.json'],
    ['other scheme', 'file:///data/style.json'],
    ['javascript', 'javascript:alert(1)'],
    ['data URL', 'data:application/json,{}'],
    ['ws', 'wss://tiles.example.com/style.json'],
    ['no host', 'https:///style.json'],
    ['empty', ''],
    ['not a URL', 'liberty'],
    ['too long', `https://tiles.example.com/${'a'.repeat(2100)}`],
  ])('rejects %s', (_name, url) => {
    expect(() => validateMapStyleUrl(url, true)).toThrow();
    expect(() => validateMapStyleUrl(url, false)).toThrow();
  });

  it('refuses the volunteer-run OSM tile servers (their usage policy forbids app traffic)', () => {
    expect(() => validateMapStyleUrl('https://tile.openstreetmap.org/style.json', false)).toThrow(/OpenStreetMap/);
    expect(() => validateMapStyleUrl('https://a.tile.openstreetmap.org/style.json', false)).toThrow(/OpenStreetMap/);
    expect(() => validateMapStyleUrl('https://tile.openstreetmap.org.evil.com/style.json', false)).not.toThrow();
  });

  it('the error never repeats the URL (it may carry a key)', () => {
    try {
      validateMapStyleUrl('http://x.example.com/style.json?key=SECRETKEY', false);
    } catch (error) {
      expect(String(error)).not.toContain('SECRETKEY');
    }
  });
});

describe('resolveMapStyles', () => {
  it('defaults to OpenFreeMap liberty (light) and dark', () => {
    expect(resolveMapStyles({ isDev: false })).toEqual({ light: DEFAULT_LIGHT_STYLE_URL, dark: DEFAULT_DARK_STYLE_URL });
    expect(DEFAULT_LIGHT_STYLE_URL).toBe('https://tiles.openfreemap.org/styles/liberty');
  });

  it('treats empty strings as unset', () => {
    expect(resolveMapStyles({ light: '', dark: '', isDev: false })).toEqual({ light: DEFAULT_LIGHT_STYLE_URL, dark: DEFAULT_DARK_STYLE_URL });
  });

  it('a custom light style without a dark one is used for both (no mixing of providers)', () => {
    const custom = 'https://api.maptiler.com/maps/streets-v2/style.json?key=k';
    expect(resolveMapStyles({ light: custom, isDev: false })).toEqual({ light: custom, dark: custom });
  });

  it('uses both when both are given', () => {
    const light = 'https://maps.example.uz/light.json';
    const dark = 'https://maps.example.uz/dark.json';
    expect(resolveMapStyles({ light, dark, isDev: false })).toEqual({ light, dark });
  });

  it('throws on an invalid configured URL instead of silently falling back', () => {
    expect(() => resolveMapStyles({ light: 'http://x.example.com/s.json', isDev: false })).toThrow();
    expect(() => resolveMapStyles({ dark: 'https://u:p@x.example.com/s.json', isDev: false })).toThrow();
  });
});

describe('attributionFor', () => {
  it('always names OpenStreetMap contributors', () => {
    for (const url of [
      DEFAULT_LIGHT_STYLE_URL,
      'https://api.maptiler.com/maps/x/style.json?key=k',
      'https://tiles.stadiamaps.com/styles/alidade_smooth.json',
      'https://maps.example.uz/style.json',
    ]) {
      expect(attributionFor(url)).toContain(OSM_ATTRIBUTION);
    }
    expect(OSM_ATTRIBUTION).toBe('© OpenStreetMap contributors');
  });

  it('adds the credit each known provider requires', () => {
    expect(attributionFor(DEFAULT_LIGHT_STYLE_URL)).toContain('OpenFreeMap');
    expect(attributionFor(DEFAULT_LIGHT_STYLE_URL)).toContain('OpenMapTiles');
    expect(attributionFor('https://api.maptiler.com/maps/x/style.json')).toContain('MapTiler');
    expect(attributionFor('https://tiles.stadiamaps.com/styles/a.json')).toContain('Stadia Maps');
  });

  it('a self-hosted style carries the configured extra credit', () => {
    expect(attributionFor('https://maps.example.uz/style.json', '© Example Maps')).toBe(`${OSM_ATTRIBUTION} · © Example Maps`);
    expect(attributionFor('https://maps.example.uz/style.json')).toBe(OSM_ATTRIBUTION);
  });

  it('cleans the extra text: no markup or control characters, bounded length', () => {
    const text = attributionFor('https://maps.example.uz/style.json', '<a href="x">Example</a>\u0000\n Maps');
    expect(text).not.toMatch(/[<>\u0000\n]/);
    expect(attributionFor('https://maps.example.uz/style.json', 'x'.repeat(500)).length).toBeLessThan(200);
  });

  it('a lookalike host does not receive another provider credit', () => {
    expect(attributionFor('https://tiles.openfreemap.org.evil.com/styles/liberty')).toBe(OSM_ATTRIBUTION);
  });

  it('survives garbage', () => {
    expect(attributionFor('not a url')).toBe(OSM_ATTRIBUTION);
  });
});
