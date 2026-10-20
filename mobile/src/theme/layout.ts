// One place for "how wide / how tall / how big is the text" decisions, so screens stop carrying
// ad-hoc numbers. Pure and tested; useScreenLayout.ts adds the live window and safe-area insets.

/** Content never gets wider than this (tablets, landscape, foldables): it is centred instead. */
export const CONTENT_MAX_WIDTH = 560;
/** Below this width (small phones) gutters shrink. */
export const COMPACT_WIDTH = 360;
/** From this width the screen is a tablet-like canvas. */
export const EXPANDED_WIDTH = 600;
/** Short windows (landscape phones, split screen): fixed-height decorations must give way. */
export const SHORT_HEIGHT = 600;
/** System font scale from which tight controls must be allowed to grow or wrap. */
export const LARGE_FONT_SCALE = 1.3;
/** Fixed-size controls (badges, map markers, tab labels) stop growing at this multiplier. */
export const TIGHT_FONT_MULTIPLIER = 1.3;

export type WidthClass = 'compact' | 'regular' | 'expanded';

export interface Layout {
  widthClass: WidthClass;
  /** Width of the centred content column: min(window, CONTENT_MAX_WIDTH). */
  contentWidth: number;
  /** Space left on each side of the column (0 on phones); bottom sheets use it as a margin. */
  sideInset: number;
  /** Screen padding. */
  gutter: number;
  /** Usable width inside the column's padding. */
  innerWidth: number;
  isLandscape: boolean;
  isShort: boolean;
  isLargeFont: boolean;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function layoutFor(width: number, height: number, fontScale: number): Layout {
  const w = finite(width, 360);
  const h = finite(height, 640);
  const widthClass: WidthClass = w < COMPACT_WIDTH ? 'compact' : w < EXPANDED_WIDTH ? 'regular' : 'expanded';
  const contentWidth = Math.min(w, CONTENT_MAX_WIDTH);
  const gutter = widthClass === 'compact' ? 16 : 24;
  return {
    widthClass,
    contentWidth,
    sideInset: Math.max(0, (w - contentWidth) / 2),
    gutter,
    innerWidth: Math.max(0, contentWidth - 2 * gutter),
    isLandscape: w > h,
    isShort: h < SHORT_HEIGHT,
    isLargeFont: finite(fontScale, 1) >= LARGE_FONT_SCALE,
  };
}
