import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { Chip } from '@/components/Chip';
import { ErrorText } from '@/components/ErrorText';
import { selectProvider, visibleProviders, type PaymentProvider, type ProviderChoice } from '@/features/payment/providerChoice';
import { usePalette } from '@/theme/theme';

interface ProviderPickerProps {
  choice: ProviderChoice;
  onChange: (next: ProviderChoice) => void;
}

/**
 * Payme | Click chips. Nothing chosen = the server default. A provider the server called
 * unavailable disappears; with none left the picker is replaced by a note and submitting is blocked.
 */
export function ProviderPicker({ choice, onChange }: ProviderPickerProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const providers = visibleProviders(choice);

  if (providers.length === 0) return <ErrorText message={t('payment.provider.noneAvailable')} />;

  const needsChoice = choice.isDefaultUnavailable && choice.selected === null;
  const hint = choice.serverDefault
    ? t('payment.provider.serverDefault', { name: t(`payment.provider.${choice.serverDefault}`) })
    : t('payment.provider.defaultHint');

  return (
    <View style={styles.group} accessibilityRole="radiogroup">
      <Text style={[styles.label, { color: p.text }]}>{t('payment.provider.title')}</Text>
      <View style={styles.row}>
        {providers.map((provider: PaymentProvider) => (
          <Chip
            key={provider}
            label={t(`payment.provider.${provider}`)}
            selected={choice.selected === provider}
            onPress={() => onChange(selectProvider(choice, provider))}
          />
        ))}
      </View>
      {needsChoice ? <ErrorText message={t('payment.provider.mustChoose')} /> : <Text style={{ color: p.textMuted }}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  label: { fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
