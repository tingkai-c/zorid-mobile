/** Native shell persists app URLs until their downloaded handler is ready. Keep
 * Expo Router on a real route while that independent queue delivers navigation. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const url = new URL(path, 'zorid://shell');
    if ((url.protocol === 'zorid:' && url.hostname === 'apps') || url.pathname.startsWith('/apps/')) return '/';
    return path;
  } catch { return '/'; }
}
