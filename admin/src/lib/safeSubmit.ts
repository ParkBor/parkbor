/**
 * Run a form submit handler once at a time. Failures are swallowed here on purpose: the caller
 * shows them through the `error` prop (bound to fields), and the typed values are kept so the
 * user can fix them. The form is reset only after a success.
 */
export async function safeSubmit<V>(
  isBusy: boolean,
  handler: (values: V) => void | Promise<void>,
  values: V,
  onSuccess: () => void,
): Promise<void> {
  if (isBusy) return
  try {
    await handler(values)
  } catch {
    return
  }
  onSuccess()
}
