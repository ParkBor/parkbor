/**
 * "Later" on the permissions screen means: do not ask again on the map until the user opens a location
 * action (the banner's Allow button, "back to my location"). Memory only: a new app run asks again.
 */
let isDeferred = false;

export const locationPrompt = {
  defer(): void {
    isDeferred = true;
  },
  /** The user chose a location action: the next request may show the system dialog. */
  clear(): void {
    isDeferred = false;
  },
  /** Whether the map may show the system permission dialog on its own right now. */
  mayPromptOnMount(): boolean {
    return !isDeferred;
  },
};
