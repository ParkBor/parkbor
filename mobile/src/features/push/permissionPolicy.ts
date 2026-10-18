export type PermissionState = 'granted' | 'denied' | 'undetermined';

export interface PushPermission {
  state: PermissionState;
  canAskAgain: boolean;
}

/** expo-notifications `NotificationPermissionsStatus`, read defensively. */
export function parsePermission(raw: unknown): PushPermission {
  if (typeof raw !== 'object' || raw === null) return { state: 'denied', canAskAgain: false };
  const { granted, canAskAgain, status } = raw as { granted?: unknown; canAskAgain?: unknown; status?: unknown };
  const canAsk = canAskAgain === true;
  if (granted === true) return { state: 'granted', canAskAgain: canAsk };
  if (status === 'undetermined') return { state: 'undetermined', canAskAgain: canAsk };
  return { state: 'denied', canAskAgain: canAsk && status === 'denied' };
}

export type SettingsAction = 'none' | 'request' | 'open_settings';

/** What the notification settings row offers: ask, send the user to the OS settings, or nothing. */
export function settingsAction(permission: PushPermission): SettingsAction {
  if (permission.state === 'granted') return 'none';
  return permission.canAskAgain ? 'request' : 'open_settings';
}

export interface PromptInput {
  permission: PushPermission;
  /** The soft prompt (or the OS prompt) was already shown during this app run. */
  hasAskedThisRun: boolean;
  /** The user just did something that makes notifications obviously useful (e.g. booked). */
  isMoment: boolean;
}

/**
 * Notifications are asked for in context - after the first confirmed booking - and never at
 * launch. At most once per app run, and not at all when the OS would not show the dialog.
 */
export function decideNotificationPrompt(input: PromptInput): 'ask' | 'skip' {
  if (!input.isMoment || input.hasAskedThisRun) return 'skip';
  const { state, canAskAgain } = input.permission;
  if (state === 'granted') return 'skip';
  return canAskAgain ? 'ask' : 'skip';
}
