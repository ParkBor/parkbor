import { useQueryClient } from '@tanstack/react-query';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { Marker } from '@maplibre/maplibre-react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { AppMap } from '@/features/map/AppMap';
import { boundsOfPath, runCamera, toLngLat } from '@/features/map/maplibreAdapter';
import type { NearbyResponse } from '@/features/map/schemas';
import { regionAround } from '@/features/map/search';
import { useLanguage } from '@/features/map/useLanguage';
import { describeInstruction } from '@/features/route/instructionText';
import {
  firstParam,
  isUuid,
  parseLatLngParams,
  resolveLot,
  type CachedLot,
  type NavigationLot,
  type RawLotParams,
} from '@/features/route/lotParams';
import {
  announcementKey,
  deriveNavigationView,
  remainingSummary,
  shouldFitRoute,
} from '@/features/route/navigationView';
import { BottomBar, InstructionCard } from '@/features/route/NavigationPanels';
import { openExternalNavigator } from '@/features/route/openExternalNavigator';
import { RouteLayer } from '@/features/route/RouteLayer';
import { ApproximateNotice, RouteErrorNotice } from '@/features/route/RouteNotices';
import type { Route } from '@/features/route/routeSchemas';
import { useNavigationSession } from '@/features/route/useNavigationSession';
import { formatDistance } from '@/features/map/format';
import { usePalette } from '@/theme/theme';

const LOT_VIEW_RADIUS_M = 400;
const KEEP_AWAKE_TAG = 'habi-navigation';
/** Panels float over the map: edge padding keeps the fitted route between them. */
const FIT_PADDING = { top: 240, right: 40, bottom: 260, left: 40 };
const FIT_MS = 500;
/** Space between the bottom bar and the map credit line. */
const CREDIT_GAP = 6;

type NavParams = RawLotParams & { fromLat?: string | string[]; fromLng?: string | string[] };

/** Lots of every cached nearby search (in-memory query cache; never persisted). */
function useCachedLots(): CachedLot[] {
  const queryClient = useQueryClient();
  return useMemo(
    () =>
      queryClient
        .getQueriesData<NearbyResponse>({ queryKey: ['parkings', 'nearby'] })
        .flatMap(([, data]) => data?.results ?? [])
        .map((lot) => ({ id: lot.id, name: lot.name, location: lot.location })),
    [queryClient],
  );
}

/** navigate/[parkingId]: validates the link, finds the lot, then runs the navigation session. */
export function NavigationScreen() {
  // Router params are untrusted text: every field is validated in lotParams before use.
  const params: NavParams = useLocalSearchParams();
  const router = useRouter();
  const cached = useCachedLots();
  const parkingId = firstParam(params.parkingId);
  const isValid = isUuid(parkingId);
  const lot = useMemo(() => (isValid ? resolveLot(params, cached) : null), [isValid, params, cached]);

  const goBack = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  // A malformed id (broken deep link) has nothing to show: leave instead of an empty screen.
  useEffect(() => {
    if (!isValid) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }
  }, [isValid, router]);

  if (!isValid) return null;
  if (lot === null) return <LotMissing onBack={goBack} />;
  return (
    <ActiveNavigation
      key={lot.id}
      lot={lot}
      initialOrigin={parseLatLngParams(params.fromLat, params.fromLng)}
      onExit={goBack}
    />
  );
}

function LotMissing({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const p = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { backgroundColor: p.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.missing}>
        <Text accessibilityRole="header" style={[styles.missingTitle, { color: p.text }]}>
          {t('nav.lotMissingTitle')}
        </Text>
        <Text style={[styles.missingText, { color: p.textMuted }]}>{t('nav.lotMissingText')}</Text>
        <Button label={t('nav.back')} onPress={onBack} />
      </View>
    </View>
  );
}

interface ActiveProps {
  lot: NavigationLot;
  initialOrigin: ReturnType<typeof parseLatLngParams>;
  onExit: () => void;
}

function ActiveNavigation({ lot, initialOrigin, onExit }: ActiveProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraRef>(null);
  // The bottom bar grows with the font size and the gesture/nav bar: the map credit is measured from its top.
  const [barHeight, setBarHeight] = useState(0);
  const fittedRoute = useRef<Route | null>(null);

  const session = useNavigationSession(lot, initialOrigin);
  const { route, progress, guidance, location, hasArrived } = session;
  const kind = deriveNavigationView({
    route,
    progress,
    locationState: location.state,
    isLoading: session.isLoading,
    hasError: session.error !== null,
    isRerouting: session.isRerouting,
  });

  // The screen stays on while navigating; released on arrival and on unmount.
  useEffect(() => {
    if (hasArrived) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [hasArrived]);

  // Camera: first route and real (osrm) routes only - not every straight-line refresh.
  useEffect(() => {
    if (!route) return;
    if (shouldFitRoute(fittedRoute.current, route)) {
      const bounds = boundsOfPath(route.path);
      if (bounds) runCamera(() => cameraRef.current?.fitBounds(bounds, { padding: FIT_PADDING, duration: FIT_MS, easing: 'ease' }));
    }
    fittedRoute.current = route;
  }, [route]);

  // Screen reader: announce only when the step or its proximity class changes (not every 2-5 m).
  const announceKey = announcementKey(kind, progress);
  const announcedKey = useRef<string | null>(null);
  useEffect(() => {
    if (announceKey === null || announceKey === announcedKey.current) return;
    announcedKey.current = announceKey;
    const next = progress?.nextStep;
    if (kind === 'turn' && next) {
      const text = describeInstruction(next.step, lang).text;
      AccessibilityInfo.announceForAccessibility(
        t('nav.nextLabel', { instruction: text, distance: formatDistance(next.distanceM, lang) }),
      );
    } else if (kind === 'arrived') {
      AccessibilityInfo.announceForAccessibility(t('nav.arrived'));
    } else if (kind === 'offRoute') {
      AccessibilityInfo.announceForAccessibility(t('nav.offRoute'));
    }
    // progress is read only to build the text; the key already encodes what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announceKey, kind, lang, t]);

  const isLocationProblem = location.state !== 'granted' && location.state !== 'loading';
  const remaining = remainingSummary(kind, route, progress, guidance);

  return (
    <View style={[styles.root, { backgroundColor: p.background }]}>
      <AppMap
        cameraRef={cameraRef}
        accessibilityLabel={t('nav.mapLabel')}
        initialRegion={regionAround(lot.location, LOT_VIEW_RADIUS_M)}
        showsUserLocation={location.state === 'granted'}
        attributionBottom={barHeight + CREDIT_GAP}
      >
        {route ? <RouteLayer route={route} /> : null}
        <Marker id="lot" lngLat={toLngLat(lot.location)} anchor="bottom" accessibilityLabel={lot.name}>
          <View style={[styles.lotPin, { backgroundColor: p.primary, borderColor: p.background }]} />
        </Marker>
      </AppMap>

      {/* Edge-to-edge (Android) and notches: panels are offset by the safe-area insets. */}
      <View style={[styles.top, { paddingTop: insets.top + 12 }]} pointerEvents="box-none">
        {kind === 'error' && session.error ? (
          <RouteErrorNotice kind={session.error} onRetry={session.retry} />
        ) : (
          <InstructionCard
            kind={kind}
            progress={progress}
            guidance={guidance}
            isRerouting={session.isRerouting}
            lang={lang}
          />
        )}
        {route?.isApproximate ? <ApproximateNotice isLarge /> : null}
        {route && session.error ? (
          <RouteErrorNotice kind={session.error} note={t('nav.rerouteFailed')} onRetry={session.retry} />
        ) : null}
        {isLocationProblem ? (
          <View style={styles.locationAction}>
            <Button
              label={location.state === 'denied' ? t('map.location.allow') : t('map.location.openSettings')}
              variant="secondary"
              onPress={location.state === 'denied' ? () => void location.requestAccess() : location.openSettings}
            />
          </View>
        ) : null}
      </View>

      <View style={styles.bottom} onLayout={(event) => setBarHeight(event.nativeEvent.layout.height)}>
        <BottomBar
          remaining={remaining}
          lang={lang}
          isArrived={kind === 'arrived'}
          bottomInset={insets.bottom}
          onExternal={() => void openExternalNavigator(lot.location, t)}
          onStop={onExit}
          onFindAnother={onExit}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  locationAction: { alignSelf: 'flex-start' },
  lotPin: { width: 26, height: 26, borderRadius: 13, borderWidth: 4 },
  missing: { flex: 1, padding: 24, gap: 16, justifyContent: 'center' },
  missingTitle: { fontSize: 24, fontWeight: '700' },
  missingText: { fontSize: 16 },
});
