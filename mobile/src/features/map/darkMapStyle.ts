import type { MapStyleElement } from 'react-native-maps';

/**
 * Google Maps night style for the Android map (iOS Apple Maps follows `userInterfaceStyle`).
 * Standard dark palette: dark land and roads, muted labels, no transit/POI clutter.
 */
export const DARK_MAP_STYLE: MapStyleElement[] = [
  { elementType: 'geometry', stylers: [{ color: '#1d2433' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#9ca3af' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1d2433' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#374151' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2f3a4f' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1d2433' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3f4d68' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#b6bfcc' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0b1220' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#6b7280' }] },
];
