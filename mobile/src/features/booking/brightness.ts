export interface BrightnessApi {
  get(): Promise<number>;
  set(value: number): Promise<void>;
  /**
   * Android: hand brightness back to the system (the window override is removed) instead of
   * pinning the old number. iOS has a single global level, so it restores the saved number.
   */
  reset?: () => Promise<void>;
}

export interface BrightnessBoost {
  /** Raise to full (remembering the user's level). Idempotent. */
  activate(): Promise<void>;
  /** Put the remembered level back. Idempotent; a no-op if never activated. */
  deactivate(): Promise<void>;
}

const FULL_BRIGHTNESS = 1;

/**
 * Brightness boost while a QR is on screen (ARCHITECTURE 13.2). The original level is read once
 * per activation and always restored; calls are serialised so a fast activate/deactivate pair
 * (screen focus flicker, AppState changes) cannot leave the phone stuck at full brightness.
 * Brightness is a convenience: platform errors are swallowed on purpose.
 */
export function createBrightnessBoost(api: BrightnessApi): BrightnessBoost {
  let original: number | null = null;
  let queue: Promise<void> = Promise.resolve();

  function serial(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task).catch(() => undefined);
    return queue;
  }

  return {
    activate: () =>
      serial(async () => {
        if (original !== null) return;
        const current = await api.get();
        await api.set(FULL_BRIGHTNESS);
        original = current;
      }),
    deactivate: () =>
      serial(async () => {
        if (original === null) return;
        const level = original;
        original = null;
        if (api.reset) await api.reset();
        else await api.set(level);
      }),
  };
}
