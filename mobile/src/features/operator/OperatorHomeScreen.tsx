import { useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { classifyOperatorError } from '@/features/operator/gateErrors';
import { lotCapabilities } from '@/features/operator/lotPolicy';
import { operatorStore } from '@/features/operator/operatorSession';
import { useActiveLot } from '@/features/operator/useOperatorLots';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface ActionRowProps {
  title: string;
  hint: string;
  href: Href;
  isDisabled?: boolean;
}

function ActionRow({ title, hint, href, isDisabled = false }: ActionRowProps) {
  const p = usePalette();
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      onPress={() => router.push(href)}
      style={[styles.row, { backgroundColor: p.surface, borderColor: p.border, opacity: isDisabled ? 0.5 : 1 }]}
    >
      <Text style={[styles.rowTitle, { color: p.text }]}>{title}</Text>
      <Text style={{ color: p.textMuted }}>{hint}</Text>
    </Pressable>
  );
}

/** Operator tab: choose the working lot, then scan / slots / walk-in. Only shown to staff roles. */
export default function OperatorHomeScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const { query, lots, lot } = useActiveLot();
  const caps = lotCapabilities(lot);

  return (
    <Screen>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('operator.home.title')}
      </Text>
      {query.isLoading ? <ActivityIndicator accessibilityLabel={t('operator.home.loading')} /> : null}
      {query.isError ? (
        <>
          <Text accessibilityRole="alert" style={{ color: p.error }}>
            {t('operator.home.loadError')} {t(classifyOperatorError(query.error).reasonKey)}
          </Text>
          <Button variant="secondary" label={t('common.retry')} onPress={() => void query.refetch()} />
        </>
      ) : null}
      {query.isSuccess && lots.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.rowTitle, { color: p.text }]}>{t('operator.home.noLots')}</Text>
          <Text style={{ color: p.textMuted }}>{t('operator.home.noLotsHint')}</Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.body}>
        {lots.length > 1 ? (
          <View style={styles.lots} accessibilityRole="radiogroup">
            <Text style={{ color: p.textMuted, fontWeight: '600' }}>{lot ? t('operator.home.currentLot') : t('operator.home.chooseLot')}</Text>
            {lots.map((item) => {
              const selected = item.id === lot?.id;
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, checked: selected }}
                  accessibilityLabel={item.name}
                  onPress={() => operatorStore.getState().selectLot(item.id)}
                  style={[styles.row, { backgroundColor: selected ? p.surface : p.background, borderColor: selected ? p.primary : p.border, borderWidth: selected ? 3 : 1 }]}
                >
                  <Text style={[styles.rowTitle, { color: p.text }]}>
                    {selected ? '✓ ' : ''}
                    {item.name}
                  </Text>
                  <Text style={{ color: p.textMuted }}>
                    {t(`operator.lot.status_${item.status}`)} · {t('operator.lot.free', { free: item.freeSlots, total: item.totalSlots })}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : lot ? (
          <View style={[styles.row, { backgroundColor: p.surface, borderColor: p.border }]}>
            <Text style={[styles.rowTitle, { color: p.text }]}>{lot.name}</Text>
            <Text style={{ color: p.textMuted }}>
              {t(`operator.lot.status_${lot.status}`)} · {t('operator.lot.free', { free: lot.freeSlots, total: lot.totalSlots })}
            </Text>
          </View>
        ) : null}

        {caps.notice && lot ? <Text style={{ color: p.warningText, fontSize: 16 }}>{t(caps.notice)}</Text> : null}

        {lot ? (
          <>
            <ActionRow title={t('operator.home.scan')} hint={t('operator.home.scanHint')} href="/operator/scan" />
            <ActionRow title={t('operator.home.slots')} hint={t('operator.home.slotsHint')} href="/operator/slots" />
            <ActionRow title={t('operator.home.walkIn')} hint={t('operator.home.walkInHint')} href="/operator/walk-in" />
          </>
        ) : null}
        <ActionRow title={t('operator.home.join')} hint={t('operator.join.linkHint')} href="/operator/join" />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700' },
  body: { gap: 12, paddingBottom: 24 },
  lots: { gap: 8 },
  empty: { gap: 4 },
  row: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 12, padding: 12, gap: 2 },
  rowTitle: { fontSize: 17, fontWeight: '700' },
});
