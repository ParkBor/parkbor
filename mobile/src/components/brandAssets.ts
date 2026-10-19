// Pixel sizes of the in-app logo files (assets/images/parkbor-*.png, written by docs/brand/derive_assets.py).
// brandAssets.test.ts compares them with the real PNG headers, so a regenerated asset cannot silently
// stretch the logo.
export const FULL_LOGO_SIZE = { width: 660, height: 200 } as const;
export const MARK_LOGO_SIZE = { width: 360, height: 431 } as const;

export function aspectRatio(size: { width: number; height: number }): number {
  return size.width / size.height;
}
