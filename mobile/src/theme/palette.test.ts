import { describe, expect, it } from 'vitest';

import { contrastRatio, darkPalette, lightPalette, type Palette } from '@/theme/palette';

const AA = 4.5;

describe('contrastRatio', () => {
  it('matches known WCAG values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe.each([
  ['light', lightPalette],
  ['dark', darkPalette],
] as [string, Palette][])('%s palette meets WCAG AA for text', (_name, p) => {
  it.each([
    ['text on background', p.text, p.background],
    ['text on surface', p.text, p.surface],
    ['muted on background', p.textMuted, p.background],
    ['muted on surface', p.textMuted, p.surface],
    ['label on primary button', p.onPrimary, p.primary],
    ['primary text (secondary button) on background', p.primary, p.background],
    ['label on telegram button', p.onTelegram, p.telegram],
    ['accent text on background', p.accentText, p.background],
    ['accent text on surface', p.accentText, p.surface],
    ['label on accent fill', p.onAccent, p.accent],
    ['success text on background', p.successText, p.background],
    ['success text on surface', p.successText, p.surface],
    ['warning text on background', p.warningText, p.background],
    ['warning text on surface', p.warningText, p.surface],
    ['error text on background', p.error, p.background],
    ['label on error (danger) button', p.onError, p.error],
  ])('%s', (_label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA);
  });

  it('keeps control borders visible (3:1 non-text contrast) on the background', () => {
    expect(contrastRatio(p.border, p.background)).toBeGreaterThanOrEqual(3);
  });
});
