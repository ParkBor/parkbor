import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { draftProblems, toPayload, type DraftProblem } from '@/features/booking/bookingDraft';
import { PeriodPicker } from '@/features/booking/PeriodPicker';
import { PriceCard } from '@/features/booking/PriceCard';
import { ProviderPicker } from '@/features/payment/ProviderPicker';
import { SlotTypePicker } from '@/features/booking/SlotTypePicker';
import { SubmitSection } from '@/features/booking/SubmitSection';
import { useBookingDraftState } from '@/features/booking/useBookingDraftState';
import { useBookingSubmit } from '@/features/booking/useBookingSubmit';
import { useQuote } from '@/features/booking/useQuote';
import { useServerNow } from '@/features/booking/useServerNow';
import { VehiclePicker } from '@/features/booking/VehiclePicker';
import { canSubmitWithProvider, payloadProvider } from '@/features/payment/providerChoice';
import { useProviderChoice } from '@/features/payment/useProviderChoice';
import { SLOT_TYPES, type NearbyResponse, type SlotType } from '@/features/map/schemas';
import { findCachedParking, isValidParkingId } from '@/features/parking/parkingView';
import { firstParam } from '@/features/route/lotParams';
import { useVehicles } from '@/features/vehicles/useVehicles';
import { usePalette } from '@/theme/theme';

const NOW_TICK_MS = 30_000;
const VEHICLE_PROBLEMS: readonly DraftProblem[] = ['no_vehicle', 'vehicle_slot_mismatch'];

const asSlotType = (value: string | undefined): SlotType | undefined => SLOT_TYPES.find((type) => type === value);

/** booking/new (modal): period, spot type, vehicle, live price, then "Pay and book". */
export function BookingFormScreen() {
  const params = useLocalSearchParams<{ lotId?: string | string[]; slotType?: string | string[] }>();
  const lotId = firstParam(params.lotId);
  const router = useRouter();
  const lotValid = isValidParkingId(lotId);

  useEffect(() => {
    if (!lotValid) router.replace('/(tabs)');
  }, [lotValid, router]);

  if (!lotValid) return null;
  return <BookingForm lotId={lotId} preselected={asSlotType(firstParam(params.slotType))} />;
}

/** Everything the booking form computes: period, vehicle, live quote, provider choice, submit. */
function useBookingForm(lotId: string, preselected: SlotType | undefined) {
  const nowMs = useServerNow(NOW_TICK_MS);
  const vehicles = useVehicles();
  const list = vehicles.data ?? [];
  const state = useBookingDraftState(nowMs, list, preselected);
  const { draft, chosen } = state;

  const problems = draftProblems(draft, chosen, nowMs, null);
  const periodProblem = problems.find((problem) => !VEHICLE_PROBLEMS.includes(problem));
  const quote = useQuote({
    lotId,
    slotType: draft.slotType,
    startMs: draft.startMs,
    endMs: draft.endMs,
    isValid: !periodProblem,
  });
  const [providers, setProviders] = useProviderChoice();
  const payload = toPayload(draft, lotId, payloadProvider(providers));
  const canSubmit = payload !== null && problems.length === 0 && quote.verdict.canSubmit && canSubmitWithProvider(providers);
  const { create, submit } = useBookingSubmit(payload, setProviders);
  return { nowMs, vehicles, list, state, problems, periodProblem, quote, providers, setProviders, canSubmit, create, submit };
}

function BookingForm({ lotId, preselected }: { lotId: string; preselected: SlotType | undefined }) {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const form = useBookingForm(lotId, preselected);
  const { nowMs, vehicles, list, state, problems, periodProblem, quote, providers, setProviders, canSubmit, create, submit } = form;
  const { draft, chosen } = state;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: p.background }]}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <FormHeader lotId={lotId} />
        <PeriodPicker draft={draft} nowMs={nowMs} onChange={state.change} />
        {periodProblem ? <ErrorText message={t(`booking.error.${periodProblem}`)} /> : null}
        <SlotTypePicker selected={draft.slotType} onSelect={state.pickSlotType} />
        <VehiclePicker
          vehicles={list}
          isLoading={vehicles.isPending}
          selectedId={chosen?.id ?? null}
          hasMismatch={problems.includes('vehicle_slot_mismatch')}
          onSelect={state.pickVehicle}
          onUseMatching={state.useMatchingSlotType}
          onAdd={() => router.push('/vehicles/edit')}
        />
        <QuoteSection quote={quote} hasPeriod={!periodProblem} />
        <ProviderPicker choice={providers} onChange={setProviders} />
        <SubmitSection failure={create.failure} isPending={create.isPending} canSubmit={canSubmit} onSubmit={() => void submit()} />
        <Button variant="secondary" label={t('common.back')} onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

function FormHeader({ lotId }: { lotId: string }) {
  const { t } = useTranslation();
  const p = usePalette();
  const queryClient = useQueryClient();
  const lot = findCachedParking(
    queryClient.getQueriesData<NearbyResponse>({ queryKey: ['parkings', 'nearby'] }).map(([, data]) => data),
    lotId,
  );
  return (
    <>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('booking.form.title')}
      </Text>
      <Text style={[styles.lot, { color: p.text }]}>{lot?.name ?? t('parking.title')}</Text>
    </>
  );
}

function QuoteSection({ quote, hasPeriod }: { quote: ReturnType<typeof useQuote>; hasPeriod: boolean }) {
  const { t } = useTranslation();
  const p = usePalette();
  const availability = quote.verdict.isCurrent ? quote.availability.data : undefined;
  return (
    <>
      {availability && !availability.isOpen ? <ErrorText message={t('booking.form.closedWarning')} /> : null}
      {availability?.isOpen && availability.available === 0 ? <ErrorText message={t('booking.form.noSlots')} /> : null}
      {availability?.isOpen && availability.available > 0 ? (
        <Text style={{ color: p.textMuted }}>{t('booking.form.slotsLeft', { count: availability.available })}</Text>
      ) : null}
      <PriceCard
        price={hasPeriod ? quote.price.data : undefined}
        isStale={hasPeriod && quote.verdict.isStale}
        isLoading={hasPeriod && (quote.price.isPending || !quote.flags.isSettled)}
        error={hasPeriod && quote.price.isError ? quote.price.error : null}
        onRetry={() => void quote.price.refetch()}
      />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  lot: { fontSize: 18, fontWeight: '600' },
});
