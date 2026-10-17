import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

export interface FocusState {
  isFocused: boolean;
  appState: AppStateStatus;
}

/** Screen focus + app foreground state: the camera and polling run only while both are true. */
export function useFocusState(): FocusState {
  const isFocused = useIsFocused();
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);
  return { isFocused, appState };
}
