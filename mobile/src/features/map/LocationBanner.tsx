import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import type { UserLocationState } from '@/features/map/UserLocation';
import { usePalette } from '@/theme/theme';

interface LocationBannerProps {
  state: UserLocationState;
  onRequestAccess: () => void;
  onOpenSettings: () => void;
}

/** Explains why the map shows central Tashkent instead of the user, with the fixing action. */
export function LocationBanner({ state, onRequestAccess, onOpenSettings }: LocationBannerProps) {
  const { t } = useTranslation();
  const p = usePalette();
  if (state === 'granted' || state === 'loading') return null;

  const title = state === 'servicesOff' ? t('map.location.servicesOffTitle') : t('map.location.deniedTitle');
  const text =
    state === 'servicesOff'
      ? t('map.location.servicesOffText')
      : state === 'blocked'
        ? t('map.location.blockedText')
        : t('map.location.deniedText');
  const action =
    state === 'denied'
      ? { label: t('map.location.allow'), onPress: onRequestAccess }
      : { label: t('map.location.openSettings'), onPress: onOpenSettings };

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.box, { backgroundColor: p.surface, borderColor: p.border }]}
    >
      <Text style={[styles.title, { color: p.text }]}>{title}</Text>
      <Text style={{ color: p.textMuted }}>{text}</Text>
      <Button variant="secondary" label={action.label} onPress={action.onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8 },
  title: { fontSize: 15, fontWeight: '700' },
});
