import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { Chip } from '@/components/Chip';
import { ErrorText } from '@/components/ErrorText';
import { profileApi } from '@/features/profile/profileService';
import { setLanguage } from '@/i18n';
import { errorMessageKey, parseApiError } from '@/lib/errors';
import type { Language } from '@/lib/types';
import { authStore } from '@/store/auth';
import { usePalette } from '@/theme/theme';

const LANGUAGES: readonly Language[] = ['uz', 'ru', 'en'];

/** The app language: applied on the phone at once and saved on the account (notifications use it). */
export function LanguageRow() {
  const { t, i18n } = useTranslation();
  const p = usePalette();
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const current = (LANGUAGES as readonly string[]).includes(i18n.language) ? (i18n.language as Language) : 'uz';

  const choose = async (language: Language): Promise<void> => {
    setErrorKey(null);
    await setLanguage(language); // the phone follows immediately, even if the server is unreachable
    try {
      const epoch = authStore.getState().getEpoch();
      const user = await profileApi.updateLanguage(language);
      await authStore.getState().setUser(user, epoch);
    } catch (error: unknown) {
      setErrorKey(errorMessageKey(parseApiError(error)));
    }
  };

  return (
    <View style={styles.root}>
      <Text style={[styles.title, { color: p.text }]}>{t('profile.language')}</Text>
      <Text style={{ color: p.textMuted }}>{t('profile.languageCurrent', { language: t(`languages.${current}`) })}</Text>
      <View accessibilityRole="radiogroup" style={styles.chips}>
        {LANGUAGES.map((language) => (
          <Chip key={language} label={t(`languages.${language}`)} selected={language === current} onPress={() => void choose(language)} />
        ))}
      </View>
      <ErrorText message={errorKey ? t(errorKey) : null} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  title: { fontSize: 16, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
