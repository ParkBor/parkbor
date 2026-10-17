import type { BookingStatus } from '@/features/booking/bookingSchemas';
import type { Palette } from '@/theme/palette';

export type StatusTone = 'success' | 'warning' | 'error' | 'primary' | 'muted';

export interface StatusView {
  labelKey: string;
  /** Shown next to the label so the state never depends on colour alone. */
  glyph: string;
  tone: StatusTone;
}

const VIEWS: Readonly<Record<BookingStatus, { glyph: string; tone: StatusTone }>> = {
  PENDING_PAYMENT: { glyph: '⏳', tone: 'warning' },
  CONFIRMED: { glyph: '✓', tone: 'success' },
  ACTIVE: { glyph: '▶', tone: 'primary' },
  OVERSTAY: { glyph: '!', tone: 'error' },
  COMPLETED: { glyph: '✔', tone: 'muted' },
  CANCELLED: { glyph: '✕', tone: 'muted' },
  EXPIRED: { glyph: '⌛', tone: 'muted' },
  NO_SHOW: { glyph: '∅', tone: 'error' },
  unknown: { glyph: '?', tone: 'muted' },
};

export function statusView(status: BookingStatus): StatusView {
  const view = VIEWS[status];
  return { labelKey: `booking.status.${status}`, glyph: view.glyph, tone: view.tone };
}

export function statusTone(status: BookingStatus): StatusTone {
  return VIEWS[status].tone;
}

/** Text-safe colour of a tone (contrast-checked variants for small text). */
export function toneColor(tone: StatusTone, palette: Palette): string {
  switch (tone) {
    case 'success':
      return palette.successText;
    case 'warning':
      return palette.warningText;
    case 'error':
      return palette.error;
    case 'primary':
      return palette.primary;
    case 'muted':
      return palette.textMuted;
  }
}

/** Server: GET /qr works only for CONFIRMED and ACTIVE (else 409 qr_not_available). */
export function canShowQr(status: BookingStatus): boolean {
  return status === 'CONFIRMED' || status === 'ACTIVE';
}

/** Cancelling is possible before check-in; ACTIVE/OVERSTAY give 409 invalid_transition. */
export function canCancelStatus(status: BookingStatus): boolean {
  return status === 'PENDING_PAYMENT' || status === 'CONFIRMED';
}

/** Statuses that can still change on their own (payment, check-in, expiry): worth polling. */
export function isLiveStatus(status: BookingStatus): boolean {
  return status === 'PENDING_PAYMENT' || status === 'CONFIRMED' || status === 'ACTIVE' || status === 'OVERSTAY';
}
