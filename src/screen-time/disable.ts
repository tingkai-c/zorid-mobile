/** Emergency release must remain effective even if the durable action path fails. */
export async function disableFocusBlocking<T>(operations: {
  saveDisabledPreference(): Promise<boolean>;
  clear(): Promise<T>;
  deletePolicy(): Promise<T>;
}): Promise<{ status: T; policyReset: boolean }> {
  let saved = false;
  try { saved = await operations.saveDisabledPreference(); }
  catch { /* Continue through native recovery when storage or handlers fail. */ }
  if (saved) return { status: await operations.clear(), policyReset: false };

  let status: T | undefined;
  let clearFailed = false;
  let resetFailed = false;
  // Clear immediately, then remove the selection so pending activations cannot
  // apply it again. Attempt both operations even when the first one rejects.
  try { status = await operations.clear(); } catch { clearFailed = true; }
  try { status = await operations.deletePolicy(); } catch { resetFailed = true; }
  if (clearFailed || resetFailed) {
    throw new Error(resetFailed
      ? 'App blocking could not be safely disabled because the saved app selection could not be reset. Retry turning it off.'
      : 'The app selection was reset, but immediate release could not be confirmed. Retry turning off app blocking.');
  }
  return { status: status!, policyReset: true };
}
