import { useTranslation } from 'react-i18next';

import { resolveLanguage } from '@/i18n/resolveLanguage';
import type { Language } from '@/lib/types';

/** Active UI language, narrowed to the three supported ones (for the map formatters). */
export function useLanguage(): Language {
  const { i18n } = useTranslation();
  return resolveLanguage(i18n.language);
}
