/** Routes describe navigation. Receiving a URL never dispatches a data action. */
export type AppRouteDestination = {
  appId: string;
  path: string[];
  query: Record<string, string>;
  url: string;
};
export type AppRoute = AppRouteDestination & {
  id: string;
  source: 'link' | 'quickAction';
  receivedAt: number;
};
export type QuickAction = {
  id: string;
  title: string;
  subtitle?: string;
  systemImage?: string;
  url: string;
};
export const MAX_QUICK_ACTIONS = 3;
const identifier = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const controls = /[\u0000-\u001f\u007f-\u009f]/;
function bytes(value: string): number {
  try { return encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, 'x').length; }
  catch { return Infinity; }
}
export function isAppId(value: string): boolean { return identifier.test(value); }

export function parseAppRoute(value: string): AppRouteDestination | null {
  try {
    if (bytes(value) > 4096 || controls.test(value) || value.includes('\\') || value.includes('#') || /%(?![\da-f]{2})/i.test(value)) return null;
    const url = new URL(value);
    if (url.protocol !== 'zorid:' || url.hostname !== 'apps' || url.username || url.password || url.port || url.hash) return null;
    // Inspect the original path because URL() resolves dot segments before
    // exposing pathname, which could hide a traversal-shaped input.
    const original = /^[^:]+:\/\/([^/?#]+)([^?#]*)/.exec(value);
    if (original?.[1] !== 'apps') return null;
    const originalPath = original[2];
    if (originalPath.includes('//')) return null;
    const segments = originalPath.split('/').filter(Boolean).map(part => decodeURIComponent(part));
    if (!segments.length || segments.length > 17 || !isAppId(segments[0])) return null;
    if (segments.some(segment => bytes(segment) > 256 || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || controls.test(segment))) return null;
    const entries = [...url.searchParams.entries()];
    if (entries.length > 16 || new Set(entries.map(([key]) => key)).size !== entries.length) return null;
    if (entries.some(([key, val]) => !key || bytes(key) > 64 || bytes(val) > 512 || controls.test(key) || controls.test(val))) return null;
    return { appId: segments[0], path: segments.slice(1), query: Object.fromEntries(entries), url: value };
  } catch { return null; }
}

export function appURL(appId: string, path: readonly string[] = [], query: Record<string, string> = {}): string {
  if (!isAppId(appId)) throw new Error('Invalid app ID.');
  const params = new URLSearchParams(query).toString();
  const url = `zorid://apps/${appId}${path.map(segment => `/${encodeURIComponent(segment)}`).join('')}${params ? `?${params}` : ''}`;
  if (!parseAppRoute(url)) throw new Error('Invalid app route.');
  return url;
}

export function validateQuickActions(appId: string, items: readonly QuickAction[]): QuickAction[] {
  if (!isAppId(appId) || items.length > MAX_QUICK_ACTIONS) throw new Error('Provide an app ID and up to three quick actions.');
  const ids = new Set<string>();
  const text = (value: unknown, maximum: number) => typeof value === 'string' && !!value.trim() && bytes(value) <= maximum && !controls.test(value);
  return items.map(item => {
    if (!item || typeof item.id !== 'string' || !identifier.test(item.id) || item.id === 'settings' || ids.has(item.id) || !text(item.title, 80)
      || (item.subtitle !== undefined && !text(item.subtitle, 120))
      || (item.systemImage !== undefined && !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(item.systemImage))
      || parseAppRoute(item.url)?.appId !== appId) throw new Error('Quick actions need unique IDs, readable labels and a route belonging to their app.');
    ids.add(item.id);
    return { id: item.id, title: item.title, subtitle: item.subtitle, systemImage: item.systemImage, url: item.url };
  });
}

export function decodeRouteQueue(json: string): AppRoute[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid route queue.');
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid route.');
    const item = entry as Record<string, unknown>;
    const destination = typeof item.url === 'string' ? parseAppRoute(item.url) : null;
    if (!destination || typeof item.id !== 'string' || !item.id || item.id.length > 128
      || (item.source !== 'link' && item.source !== 'quickAction') || typeof item.receivedAt !== 'number' || !Number.isFinite(item.receivedAt)) throw new Error('Invalid route.');
    return { ...destination, id: item.id, source: item.source, receivedAt: item.receivedAt };
  });
}
