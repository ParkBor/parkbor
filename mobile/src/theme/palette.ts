export interface Palette {
  background: string;
  surface: string;
  text: string;
  /** Secondary text; safe on both background and surface. */
  textMuted: string;
  border: string;
  /** Brand blue (buttons, links, selected state). */
  primary: string;
  onPrimary: string;
  /** Brand green: decorative fills (logo "Bor", highlights); not for text. */
  accent: string;
  /** Brand-green TEXT: >= 4.5:1 on background and surface. */
  accentText: string;
  /** Label colour on an `accent` fill. */
  onAccent: string;
  telegram: string;
  onTelegram: string;
  /** Fills / indicators (not for small text). */
  success: string;
  warning: string;
  /** Text-safe variants of success/warning/error (>= 4.5:1 on background). */
  successText: string;
  warningText: string;
  error: string;
  /** Label color on an `error` background (danger button). */
  onError: string;
}

export const lightPalette: Palette = {
  background: '#FFFFFF',
  surface: '#F3F4F6',
  text: '#111827',
  textMuted: '#4B5563',
  border: '#6B7280',
  // Brand blue sampled from the logo (#0057B5), contrast on white 6.9:1.
  primary: '#0057B5',
  onPrimary: '#FFFFFF',
  // Brand green sampled from the logo (#3CC755) is only 2:1 on white, so text uses a darker shade of it.
  accent: '#3CC755',
  accentText: '#177A32',
  onAccent: '#0B0F17',
  telegram: '#1A78AE',
  onTelegram: '#FFFFFF',
  success: '#16A34A',
  warning: '#F59E0B',
  successText: '#15803D',
  warningText: '#B45309',
  error: '#DC2626',
  onError: '#FFFFFF',
};

export const darkPalette: Palette = {
  background: '#0B0F17',
  surface: '#1A2230',
  text: '#F3F4F6',
  textMuted: '#9CA3AF',
  border: '#6B7280',
  // Lightened brand blue: #0057B5 itself is only about 2.6:1 on the dark background.
  primary: '#4DA3FF',
  onPrimary: '#0B0F17',
  accent: '#3CC755',
  accentText: '#3CC755',
  onAccent: '#0B0F17',
  telegram: '#1A78AE',
  onTelegram: '#FFFFFF',
  success: '#22C55E',
  warning: '#FBBF24',
  successText: '#22C55E',
  warningText: '#FBBF24',
  error: '#F87171',
  onError: '#0B0F17',
};

function channel(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.x contrast ratio between two #RRGGBB colors. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
