import { describe, expect, it, vi } from 'vitest';

import { createBrightnessBoost, type BrightnessApi } from '@/features/booking/brightness';

function fakeApi(initial = 0.4) {
  let level = initial;
  const api: BrightnessApi = {
    get: vi.fn(async () => level),
    set: vi.fn(async (value: number) => {
      level = value;
    }),
  };
  return { api, level: () => level, setLevel: (v: number) => (level = v) };
}

describe('createBrightnessBoost', () => {
  it('raises to full and restores the previous level', async () => {
    const f = fakeApi(0.4);
    const boost = createBrightnessBoost(f.api);
    await boost.activate();
    expect(f.level()).toBe(1);
    await boost.deactivate();
    expect(f.level()).toBe(0.4);
  });

  it('activating twice does not remember the boosted level as the original', async () => {
    const f = fakeApi(0.4);
    const boost = createBrightnessBoost(f.api);
    await boost.activate();
    await boost.activate();
    await boost.deactivate();
    expect(f.level()).toBe(0.4);
  });

  it('deactivate without activate is a no-op', async () => {
    const f = fakeApi(0.4);
    const boost = createBrightnessBoost(f.api);
    await boost.deactivate();
    expect(f.api.set).not.toHaveBeenCalled();
  });

  it('a quick activate/deactivate pair ends restored even if the calls overlap', async () => {
    const f = fakeApi(0.4);
    const boost = createBrightnessBoost(f.api);
    const pending = boost.activate();
    const done = boost.deactivate();
    await Promise.all([pending, done]);
    expect(f.level()).toBe(0.4);
  });

  it('uses the platform reset (Android: back to system brightness) instead of pinning the old number', async () => {
    const f = fakeApi(0.4);
    const reset = vi.fn(async () => undefined);
    const boost = createBrightnessBoost({ ...f.api, reset });
    await boost.activate();
    await boost.deactivate();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(f.api.set).toHaveBeenCalledTimes(1); // only the boost itself
  });

  it('can be reused after a restore', async () => {
    const f = fakeApi(0.3);
    const boost = createBrightnessBoost(f.api);
    await boost.activate();
    await boost.deactivate();
    f.setLevel(0.6);
    await boost.activate();
    await boost.deactivate();
    expect(f.level()).toBe(0.6);
  });

  it('survives a failing platform API (brightness is only a convenience)', async () => {
    const api: BrightnessApi = {
      get: vi.fn().mockRejectedValue(new Error('denied')),
      set: vi.fn().mockRejectedValue(new Error('denied')),
    };
    const boost = createBrightnessBoost(api);
    await expect(boost.activate()).resolves.toBeUndefined();
    await expect(boost.deactivate()).resolves.toBeUndefined();
  });

  it('a failed read does not leave a half-active state that blocks a later restore', async () => {
    const f = fakeApi(0.5);
    vi.mocked(f.api.get).mockRejectedValueOnce(new Error('transient'));
    const boost = createBrightnessBoost(f.api);
    await boost.activate(); // read failed: nothing changed
    expect(f.api.set).not.toHaveBeenCalled();
    await boost.activate(); // second try works
    expect(f.level()).toBe(1);
    await boost.deactivate();
    expect(f.level()).toBe(0.5);
  });
});
