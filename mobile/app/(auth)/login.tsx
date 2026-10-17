import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { Screen } from '@/components/Screen';
import { loginStore } from '@/features/auth/loginStore';
import { setLanguage } from '@/i18n';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

const LANGUAGES = ['uz', 'ru', 'en'] as const;

export default function LoginScreen() {
  const { t, i18n } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const [isBusy, setIsBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const handleLogin = async () => {
    setIsBusy(true);
    setErrorKey(null);
    const result = await loginStore.getState().start();
    setIsBusy(false);
    // Telegram failing to open still leaves a valid session: the code screen offers "reopen bot".
    if (result.ok || result.errorKey === 'errors.cannotOpenTelegram') router.push('/(auth)/code');
    if (!result.ok) setErrorKey(result.errorKey);
  };

  return (
    <Screen>
      <View style={styles.hero}>
        <Text style={[styles.logo, { color: p.primary }]}>{t('login.title')}</Text>
        <Text style={[styles.subtitle, { color: p.text }]}>{t('login.subtitle')}</Text>
      </View>
      <ErrorText message={errorKey ? t(errorKey) : null} />
      <Button variant="telegram" label={isBusy ? t('login.opening') : t('login.telegramButton')} loading={isBusy} onPress={() => void handleLogin()} />
      <Text style={[styles.terms, { color: p.textMuted }]}>{t('login.terms')}</Text>
      <View accessibilityLabel={t('login.language')} style={styles.languages}>
        {LANGUAGES.map((lang) => (
          <Pressable
            key={lang}
            accessibilityRole="button"
            accessibilityLabel={t(`languages.${lang}`)}
            accessibilityState={{ selected: i18n.language === lang }}
            onPress={() => void setLanguage(lang)}
            style={styles.langButton}
          >
            <Text style={{ color: i18n.language === lang ? p.primary : p.textMuted, fontWeight: '600' }}>
              {lang.toUpperCase()}
            </Text>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  logo: { fontSize: 44, fontWeight: '800' },
  subtitle: { fontSize: 20, textAlign: 'center' },
  terms: { fontSize: 13, textAlign: 'center' },
  languages: { flexDirection: 'row', justifyContent: 'flex-end' },
  langButton: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
});
