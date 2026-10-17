import { contrastRatio, type Palette } from '@/theme/palette';

export type MarkerKind = 'green' | 'yellow' | 'red' | 'gray';

/** Neutral gray for closed lots; readable on both light and dark maps. */
const CLOSED_FILL = '#6B7280';
const LIGHT_TEXT = '#FFFFFF';
const DARK_TEXT = '#111827';

/**
 * Availability color (doc 11.2): green > 30% free, yellow 10-30%, red < 10%, gray when closed.
 * Integer math keeps the 30% / 10% boundaries exact.
 */
export function markerColor(freeSlots: number, totalSlots: number, isOpen: boolean): MarkerKind {
  if (!isOpen) return 'gray';
  if (!Number.isFinite(freeSlots) || !Number.isFinite(totalSlots) || totalSlots <= 0 || freeSlots <= 0) {
    return 'red';
  }
  if (freeSlots * 10 > totalSlots * 3) return 'green';
  if (freeSlots * 10 >= totalSlots) return 'yellow';
  return 'red';
}

/** Text inside a marker: free slots, or a dash for closed lots (a count would mislead). */
export function markerLabel(freeSlots: number, isOpen: boolean): string {
  return isOpen ? String(freeSlots) : '—';
}

export function markerFill(kind: MarkerKind, palette: Palette): string {
  switch (kind) {
    case 'green':
      return palette.success;
    case 'yellow':
      return palette.warning;
    case 'red':
      return palette.error;
    case 'gray':
      return CLOSED_FILL;
  }
}

/** Label color with the better contrast on the given #RRGGBB fill. */
export function readableTextColor(background: string): string {
  return contrastRatio(LIGHT_TEXT, background) >= contrastRatio(DARK_TEXT, background) ? LIGHT_TEXT : DARK_TEXT;
}
