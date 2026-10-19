import type { ExpoConfig } from 'expo/config';

import { resolvePaymentSandbox } from './config/paymentSandbox';

// EAS sets EAS_BUILD_PROFILE during builds; APP_ENV=production covers local prod checks.
const isProduction =
  process.env.EAS_BUILD_PROFILE === 'production' || process.env.APP_ENV === 'production';

/** Env value; localhost-style fallback is allowed in dev only, production must set it. */
function envOrDevDefault(name: string, devDefault: string): string {
  // Config runs in Node at build time, not in the app bundle: dynamic env access is fine here.
  // eslint-disable-next-line expo/no-dynamic-env-var
  const value = process.env[name];
  if (value) return value;
  if (isProduction) {
    throw new Error(`${name} must be set for production builds`);
  }
  return devDefault;
}

const config: ExpoConfig = {
  name: 'ParkBor',
  slug: 'parkbor',
  // Deep links: parkbor://booking/<uuid>, parkbor://payment/result (the old habi:// scheme is NOT accepted).
  scheme: 'parkbor',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  userInterfaceStyle: 'automatic',
  // Localised iOS permission prompts (the expo-location plugin text below is the Uzbek default).
  locales: { ru: './locales/ru.json', en: './locales/en.json' },
  ios: {
    // Placeholder identifiers: the owner may change them (here and in the EAS / store consoles) until the first
    // store release; after that they are permanent. See docs/brand/README.md.
    bundleIdentifier: 'uz.parkbor.app',
    // External navigators are detected with Linking.canOpenURL: iOS only answers for declared
    // schemes. Apple Maps (https://maps.apple.com) needs no entry.
    infoPlist: { LSApplicationQueriesSchemes: ['yandexnavi', 'comgooglemaps'] },
  },
  android: {
    package: 'uz.parkbor.app',
    // Tokens live in the Keystore-backed SecureStore; do not let adb/cloud backup copy app data.
    allowBackup: false,
    adaptiveIcon: {
      backgroundColor: '#FFFFFF',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-localization',
    'expo-notifications',
    // MapLibre (OpenStreetMap vector tiles): no Google or Apple map keys. Native SDKs come from the plugin
    // defaults (Android MapLibre Native, iOS via Swift Package Manager); the default Android location engine
    // does not need Google Play Services.
    '@maplibre/maplibre-react-native',
    // Release builds refuse cleartext HTTP; dev needs it for the local API.
    [
      'expo-build-properties',
      {
        android: {
          usesCleartextTraffic: !isProduction,
          // Android 11+ package visibility: lets canOpenURL see installed navigators.
          manifestQueries: {
            intent: [
              { action: 'android.intent.action.VIEW', data: { scheme: 'yandexnavi' } },
              { action: 'android.intent.action.VIEW', data: { scheme: 'google.navigation' } },
              // geo: is only used as the last-resort hand-off (no probing needed).
            ],
          },
        },
      },
    ],
    // QR scanner for operator mode. Camera only: no microphone (iOS prompt off, Android RECORD_AUDIO off).
    // The iOS prompt text below is the Uzbek default; ru/en come from ./locales (NSCameraUsageDescription).
    [
      'expo-camera',
      {
        cameraPermission: 'ParkBor kameradan faqat kirish va chiqishda QR kodlarni o‘qish uchun foydalanadi. Tasvir saqlanmaydi.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-location',
      { locationWhenInUsePermission: 'ParkBor yaqin atrofdagi avtoturargohlarni ko‘rsatish uchun joylashuvingizdan foydalanadi.' },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/images/splash-icon.png',
        imageWidth: 240,
        resizeMode: 'contain',
        // The wordmark's dark blue "Park" needs a light ground, so there is no dark splash variant.
        backgroundColor: '#FFFFFF',
      },
    ],
  ],
  web: { favicon: './assets/images/favicon.png' },
  experiments: { typedRoutes: true },
  extra: {
    apiUrl: envOrDevDefault('EXPO_PUBLIC_API_URL', 'http://localhost:8000/api/v1'),
    wsUrl: envOrDevDefault('EXPO_PUBLIC_WS_URL', 'ws://localhost:8000/ws'),
    telegramBot: envOrDevDefault('EXPO_PUBLIC_TELEGRAM_BOT', 'parkbor_dev_bot'),
    // Map style (MapLibre style JSON URL). Empty = built-in default (OpenFreeMap, keyless). See docs 13.8.
    mapStyleUrl: process.env.EXPO_PUBLIC_MAP_STYLE_URL ?? '',
    mapStyleUrlDark: process.env.EXPO_PUBLIC_MAP_STYLE_URL_DARK ?? '',
    mapAttribution: process.env.EXPO_PUBLIC_MAP_ATTRIBUTION ?? '',
    // EAS project id (@parkbor/parkbor; public, not a secret): getExpoPushTokenAsync and the EAS CLI need it.
    // EXPO_PUBLIC_EAS_PROJECT_ID overrides it (for example another Expo account).
    eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID || '00dc4fa1-69ea-4b36-901f-e57db4036201' },
    // Payme test checkout (test.paycom.uz) is accepted only when this is true. Never in production:
    // resolvePaymentSandbox throws if EXPO_PUBLIC_PAYMENT_SANDBOX=true meets a production build.
    paymentSandbox: resolvePaymentSandbox(process.env.EXPO_PUBLIC_PAYMENT_SANDBOX, isProduction),
    // Build / update channel marker: the app refuses the sandbox on a production channel.
    buildChannel: process.env.APP_ENV ?? process.env.EAS_BUILD_PROFILE ?? '',
  },
};

export default config;
