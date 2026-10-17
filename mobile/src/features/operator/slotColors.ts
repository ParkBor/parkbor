import type { SlotTone } from '@/features/operator/slotView';
import type { Palette } from '@/theme/palette';

/** Border / text colours of a slot tone, from the light or dark palette (always paired with a glyph). */
export function slotToneColors(tone: SlotTone, p: Palette): { border: string; text: string } {
  switch (tone) {
    case 'success':
      return { border: p.success, text: p.successText };
    case 'primary':
      return { border: p.primary, text: p.primary };
    case 'warning':
      return { border: p.warning, text: p.warningText };
    case 'error':
      return { border: p.error, text: p.error };
    case 'muted':
      return { border: p.border, text: p.textMuted };
  }
}
