import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useLoginStore } from '@/features/auth/loginStore';
import { usePalette } from '@/theme/theme';
import { useScreenLayout } from '@/theme/useScreenLayout';

const SLIDES = ['slide1', 'slide2', 'slide3'] as const;

export default function WelcomeScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const { innerWidth } = useScreenLayout();
  // The app was killed during a login: go straight back to the code screen instead of the first slide.
  const resumedLogin = useLoginStore((s) => s.session !== null);
  useEffect(() => {
    if (resumedLogin) router.replace('/(auth)/code');
  }, [resumedLogin, router]);
  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  const isLast = index === SLIDES.length - 1;
  const slideWidth = innerWidth; // the padded, width-capped column

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(Math.round(e.nativeEvent.contentOffset.x / slideWidth));
  };
  const goLogin = () => router.push('/(auth)/login');
  const handleNext = () => {
    if (isLast) goLogin();
    else scrollRef.current?.scrollTo({ x: (index + 1) * slideWidth, animated: true });
  };

  return (
    <Screen>
      <View style={styles.header}>
        <BrandLogo variant="full" width={170} />
        <View style={styles.skipRow}>
          {!isLast && <Button variant="secondary" label={t('common.skip')} onPress={goLogin} />}
        </View>
      </View>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        style={styles.slides}
      >
        {SLIDES.map((slide) => (
          // a slide scrolls on its own when large fonts / small screens make the text taller than the page
          <ScrollView key={slide} style={{ width: slideWidth }} contentContainerStyle={styles.slide}>
            <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
              {t(`welcome.${slide}Title`)}
            </Text>
            <Text style={[styles.text, { color: p.textMuted }]}>{t(`welcome.${slide}Text`)}</Text>
          </ScrollView>
        ))}
      </ScrollView>
      <Text
        accessibilityLabel={t('welcome.slideOf', { current: index + 1, total: SLIDES.length })}
        style={[styles.dots, { color: p.textMuted }]}
      >
        {SLIDES.map((s, i) => (i === index ? '●' : '○')).join(' ')}
      </Text>
      <Button label={isLast ? t('welcome.start') : t('common.next')} onPress={handleNext} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 56 },
  skipRow: { minHeight: 48, alignItems: 'flex-end', justifyContent: 'center' },
  slides: { flex: 1 },
  slide: { flexGrow: 1, justifyContent: 'center', gap: 16 },
  title: { fontSize: 28, fontWeight: '700' },
  text: { fontSize: 17, lineHeight: 24 },
  dots: { textAlign: 'center', fontSize: 18, letterSpacing: 4 },
});
