import { useQueryClient } from '@tanstack/react-query';
import { Tabs } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from 'react-native';

import { operatorStore } from '@/features/operator/operatorSession';
import { operatorTabVisible, shouldFetchOperatorLots } from '@/features/operator/tabVisibility';
import { useOperatorLots } from '@/features/operator/useOperatorLots';
import { useRoleRefresh } from '@/features/operator/useRoleRefresh';
import { useAuthStore } from '@/store/auth';
import { usePalette } from '@/theme/theme';

function TabGlyph({ glyph }: { glyph: string }) {
  return (
    <Text accessible={false} style={{ fontSize: 20 }}>
      {glyph}
    </Text>
  );
}

// The Operator tab exists only for staff roles (operatorTabVisible). Hiding it is a convenience:
// every operator endpoint checks role and lot on the server.
export default function TabsLayout() {
  const { t } = useTranslation();
  const p = usePalette();
  const role = useAuthStore((s) => s.user?.role);
  const lots = useOperatorLots();
  useRoleRefresh();
  const queryClient = useQueryClient();
  // A role that lost staff access (assignment removed) must not leave lots / slots / the chosen lot behind.
  useEffect(() => {
    if (!shouldFetchOperatorLots(role)) {
      queryClient.removeQueries({ queryKey: ['operator'] });
      operatorStore.getState().reset();
    }
  }, [role, queryClient]);
  const showOperator = operatorTabVisible({ role, lotCount: lots.data ? lots.data.length : null });
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: p.primary,
        tabBarInactiveTintColor: p.textMuted,
        tabBarStyle: { backgroundColor: p.background, borderTopColor: p.border },
        tabBarLabelStyle: { fontSize: 12 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: t('tabs.map'), tabBarButtonTestID: 'tab-map', tabBarIcon: () => <TabGlyph glyph="🗺" /> }}
      />
      <Tabs.Screen
        name="bookings"
        options={{ title: t('tabs.bookings'), tabBarButtonTestID: 'tab-bookings', tabBarIcon: () => <TabGlyph glyph="🎫" /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: t('tabs.profile'), tabBarButtonTestID: 'tab-profile', tabBarIcon: () => <TabGlyph glyph="👤" /> }}
      />
      <Tabs.Screen
        name="operator"
        options={{
          title: t('tabs.operator'),
          tabBarButtonTestID: 'tab-operator',
          // href: null removes the tab (and its route) from the bar for non-staff accounts.
          href: showOperator ? undefined : null,
          tabBarIcon: () => <TabGlyph glyph="🛂" />,
        }}
      />
    </Tabs>
  );
}
