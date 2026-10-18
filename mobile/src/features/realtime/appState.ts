/**
 * iOS reports `inactive` for the notification shade, the app switcher, a call banner and the
 * permission dialog. The app is still on screen then, so only `background` tears the socket down
 * (otherwise every pulled-down shade would cost a reconnect and a fresh ticket).
 */
export function isForegroundState(appState: string): boolean {
  return appState !== 'background';
}
