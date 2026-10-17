import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { classifyOperatorError, withAutoRetry } from '@/features/operator/gateErrors';
import { lotCapabilities } from '@/features/operator/lotPolicy';
import { operatorApi } from '@/features/operator/operatorApi';
import { OperatorHeader } from '@/features/operator/OperatorHeader';
import type { MapSlot } from '@/features/operator/operatorSchemas';
import { SlotDetail } from '@/features/operator/SlotDetail';
import { SlotGrid, SlotLegend } from '@/features/operator/SlotGrid';
import { canForceSlot } from '@/features/operator/tabVisibility';
import { operatorKeys, useActiveLot } from '@/features/operator/useOperatorLots';
import { useSlotMap } from '@/features/operator/useSlotMap';
import { useAuthStore } from '@/store/auth';
import { usePalette } from '@/theme/theme';

interface StatusRequest {
  slotId: string;
  status: 'FREE' | 'OUT_OF_SERVICE';
  force: boolean;
}

/** Slot map: floor/zone grid, coloured cells with glyphs, details, FREE / OUT_OF_SERVICE, 15 s polling. */
export function SlotsScreen() {
  usePreventScreenCapture();
  const { t } = useTranslation();
  const p = usePalette();
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const { query: lotsQuery, lot } = useActiveLot();
  const map = useSlotMap(lot?.id ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [affectedText, setAffectedText] = useState<string | null>(null);
  const caps = lotCapabilities(lot);

  const change = useMutation({
    mutationFn: (request: StatusRequest) => withAutoRetry(() => operatorApi.setSlotStatus(request)),
    onSuccess: (result) => {
      setErrorText(null);
      setAffectedText(result.affectedBookings > 0 ? t('operator.slots.affected', { count: result.affectedBookings }) : null);
      setSelectedId(null);
      if (lot) void queryClient.invalidateQueries({ queryKey: operatorKeys.slots(lot.id) });
    },
  });

  function submit(request: StatusRequest): void {
    setErrorText(null);
    change.mutate(request, {
      onError: (error) => {
        const failure = classifyOperatorError(error);
        if (failure.code === 'slot_has_bookings' && canForceSlot(role) && !request.force) {
          // Owner / admin may force it - after an explicit confirmation. The server re-checks the role.
          Alert.alert(t('operator.slots.forceTitle'), t('operator.slots.forceText'), [
            { text: t('operator.manual.cancel'), style: 'cancel' },
            { text: t('operator.slots.forceConfirm'), style: 'destructive', onPress: () => submit({ ...request, force: true }) },
          ]);
          return;
        }
        setErrorText(t(failure.reasonKey));
        // slot_in_use / slot_has_bookings mean the map was stale: look again.
        void map.refetch();
      },
    });
  }

  const data = map.data;
  const selected: MapSlot | null = data?.slots.find((slot) => slot.id === selectedId) ?? null;

  if (lotsQuery.isLoading) {
    return (
      <Screen>
        <OperatorHeader title={t('operator.slots.title')} />
        <ActivityIndicator accessibilityLabel={t('common.loading')} />
      </Screen>
    );
  }
  if (lot === null) {
    return (
      <Screen>
        <OperatorHeader title={t('operator.slots.title')} />
        <Text style={{ color: p.text }}>{t('operator.scan.lotMissing')}</Text>
      </Screen>
    );
  }

  return (
    <Screen>
      <OperatorHeader title={t('operator.slots.title')} subtitle={lot.name} />
      {caps.notice ? <Text style={{ color: p.warningText }}>{t(caps.notice)}</Text> : null}
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={map.isRefetching} onRefresh={() => void map.refetch()} />}
      >
        {map.isPending ? <ActivityIndicator accessibilityLabel={t('common.loading')} /> : null}
        {map.isError ? (
          <>
            <Text accessibilityRole="alert" style={{ color: p.error }}>
              {data ? t('operator.slots.stale') : t('operator.slots.loadError')}
            </Text>
            <Text style={{ color: p.textMuted }}>{t(classifyOperatorError(map.error).reasonKey)}</Text>
            <Button variant="secondary" label={t('common.retry')} onPress={() => void map.refetch()} />
          </>
        ) : null}
        {data ? (
          <>
            {data.truncated ? <Text style={{ color: p.warningText, fontWeight: '700' }}>{t('operator.slots.truncated')}</Text> : null}
            {affectedText ? <Text accessibilityLiveRegion="polite" style={{ color: p.warningText, fontWeight: '700' }}>{affectedText}</Text> : null}
            <SlotLegend slots={data.slots} />
            {data.slots.length === 0 ? <Text style={{ color: p.textMuted }}>{t('operator.slots.empty')}</Text> : null}
            <SlotGrid
              slots={data.slots}
              onSelect={(slot) => {
                setErrorText(null);
                setSelectedId(slot.id);
              }}
            />
            <Text style={{ color: p.textMuted }}>{t('operator.slots.autoRefresh')}</Text>
          </>
        ) : null}
      </ScrollView>
      <SlotDetail
        slot={selected}
        lotStatus={lot.status}
        isBusy={change.isPending}
        errorText={errorText}
        onClose={() => setSelectedId(null)}
        onSetStatus={(status) => selected && submit({ slotId: selected.id, status, force: false })}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16, paddingBottom: 24 },
});
