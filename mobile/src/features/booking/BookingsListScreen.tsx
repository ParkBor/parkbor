import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ListSkeleton } from '@/features/map/StateViews';
import { Chip } from '@/components/Chip';
import { ErrorText } from '@/components/ErrorText';
import { Screen } from '@/components/Screen';
import type { BookingScope } from '@/features/booking/bookingApi';
import { classifyBookingError } from '@/features/booking/bookingErrors';
import { BookingCard } from '@/features/booking/BookingCard';
import { useBookingsList } from '@/features/booking/useBookings';
import { loadState } from '@/lib/loadState';
import { usePalette } from '@/theme/theme';

const SCOPES: readonly BookingScope[] = ['active', 'upcoming', 'history'];
const EMPTY_KEY: Readonly<Record<BookingScope, string>> = {
  active: 'booking.list.emptyActive',
  upcoming: 'booking.list.emptyUpcoming',
  history: 'booking.list.emptyHistory',
};

type ListQuery = ReturnType<typeof useBookingsList>;

/** Tab "Bronlarim": Active | Upcoming | History with pagination, pull-to-refresh and empty/error/offline states. */
export function BookingsListScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const [scope, setScope] = useState<BookingScope>('upcoming');
  const list = useBookingsList(scope);
  const state = loadState({
    hasData: list.items.length > 0,
    isPending: list.isPending,
    isError: list.isError,
    fetchStatus: list.fetchStatus,
  });

  return (
    <Screen>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('booking.list.title')}
      </Text>
      <View style={styles.tabs} accessibilityRole="tablist">
        {SCOPES.map((option) => (
          <Chip key={option} label={t(`booking.list.${option}`)} selected={scope === option} onPress={() => setScope(option)} />
        ))}
      </View>
      {state === 'offline' || state === 'error' ? (
        <ListFailure list={list} state={state} />
      ) : (
        <BookingsFlatList list={list} scope={scope} isLoading={state === 'loading'} />
      )}
    </Screen>
  );
}

function ListFailure({ list, state }: { list: ListQuery; state: 'offline' | 'error' }) {
  const { t } = useTranslation();
  const failure = state === 'error' ? classifyBookingError(list.error) : null;
  const isOffline = state === 'offline' || failure?.key === 'failure.network';
  return (
    <View style={styles.center}>
      <ErrorText message={isOffline ? t('booking.list.offline') : t(failure?.key ?? 'failure.generic')} />
      <Button variant="secondary" label={t('common.retry')} onPress={() => void list.refetch()} />
    </View>
  );
}

function BookingsFlatList({ list, scope, isLoading }: { list: ListQuery; scope: BookingScope; isLoading: boolean }) {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const failure = list.isError ? classifyBookingError(list.error) : null;

  return (
    <FlatList
      data={list.items}
      keyExtractor={(booking) => booking.id}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} />
      }
      onEndReachedThreshold={0.4}
      onEndReached={() => {
        if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
      }}
      renderItem={({ item }) => (
        <BookingCard
          booking={item}
          onPress={(booking) => router.push({ pathname: '/booking/[id]', params: { id: booking.id } })}
          onPay={(booking) => router.push({ pathname: '/booking/pay', params: { id: booking.id } })}
        />
      )}
      ListHeaderComponent={
        <>
          {failure ? <ErrorText message={failure.key === 'failure.network' ? t('booking.list.offline') : t(failure.key)} /> : null}
          {list.skipped > 0 ? <ErrorText message={t('booking.list.skipped')} /> : null}
        </>
      }
      ListEmptyComponent={
        isLoading ? <ListSkeleton /> : <EmptyView scope={scope} />
      }
      ListFooterComponent={
        list.isFetchingNextPage ? (
          <Text style={{ color: p.textMuted }}>{t('booking.list.loadingMore')}</Text>
        ) : list.hasNextPage ? (
          <Button variant="secondary" label={t('booking.list.loadMore')} onPress={() => void list.fetchNextPage()} />
        ) : null
      }
    />
  );
}

function EmptyView({ scope }: { scope: BookingScope }) {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  return (
    <View style={styles.center}>
      <Text style={[styles.emptyTitle, { color: p.text }]}>{t(EMPTY_KEY[scope])}</Text>
      <Text style={{ color: p.textMuted }}>{t('booking.list.emptyText')}</Text>
      <Button variant="secondary" label={t('booking.list.toMap')} onPress={() => router.navigate('/')} />
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700' },
  tabs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  list: { gap: 12, flexGrow: 1 },
  center: { gap: 8, alignItems: 'center', paddingVertical: 24 },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
});
