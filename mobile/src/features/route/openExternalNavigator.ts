import type { TFunction } from 'i18next';
import { Alert, Linking, Platform } from 'react-native';

import type { LatLng } from '@/features/map/geo';
import { buildNavUrl, detectAvailableApps, type NavApp, type NavPlatform } from '@/features/route/externalNav';

const APP_LABEL_KEY = {
  yandex: 'nav.appYandex',
  google: 'nav.appGoogle',
  apple: 'nav.appApple',
  geo: 'nav.external',
} as const satisfies Record<NavApp, string>;

function currentPlatform(): NavPlatform {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

async function launch(app: NavApp, destination: LatLng, t: TFunction): Promise<void> {
  const url = buildNavUrl(app, destination, currentPlatform());
  try {
    if (url === null) throw new Error('unbuildable');
    await Linking.openURL(url);
  } catch {
    // No details: the URL contains the destination coordinates.
    Alert.alert(t('nav.cannotOpen'));
  }
}

/**
 * Hands the destination to an installed navigator. With one installed app it opens directly,
 * with several the user picks, with none a message explains. Only the destination coordinates
 * leave this app. Wiring over externalNav (unit tested); the OS calls are not.
 */
export async function openExternalNavigator(destination: LatLng, t: TFunction): Promise<void> {
  const apps = await detectAvailableApps(currentPlatform(), (url) => Linking.canOpenURL(url));
  const [only] = apps;
  if (only === undefined) {
    // Android without a known navigator: the generic geo: URI lets the system offer any map app.
    if (currentPlatform() === 'android') {
      await launch('geo', destination, t);
      return;
    }
    Alert.alert(t('nav.external'), t('nav.noExternal'));
    return;
  }
  if (apps.length === 1) {
    await launch(only, destination, t);
    return;
  }
  Alert.alert(
    t('nav.externalChoose'),
    undefined,
    [
      ...apps.map((app) => ({ text: t(APP_LABEL_KEY[app]), onPress: () => void launch(app, destination, t) })),
      { text: t('common.back'), style: 'cancel' as const },
    ],
    { cancelable: true },
  );
}
