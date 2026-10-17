import { useTranslation } from 'react-i18next';

import { formatClock } from '@/features/booking/timeSlots';
import { formatDuration, formatPrice } from '@/features/map/format';
import { useLanguage } from '@/features/map/useLanguage';

export interface OperatorFormat {
  /** Server decimal string -> "12 000 so'm". The amount itself is never altered or computed. */
  money: (amount: string) => string;
  /** HH:MM, Asia/Tashkent. */
  clock: (ms: number) => string;
  duration: (minutes: number) => string;
}

export function useOperatorFormat(): OperatorFormat {
  const lang = useLanguage();
  const { t } = useTranslation();
  return {
    money: (amount) => formatPrice(amount, lang) ?? amount,
    clock: formatClock,
    duration: (minutes) => formatDuration(minutes * 60, lang) ?? t('operator.card.minutes', { count: minutes }),
  };
}
