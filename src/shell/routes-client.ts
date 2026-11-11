import { requireOptionalNativeModule } from 'expo';
import { AppState } from 'react-native';
import { decodeRouteQueue, isAppId } from './routes';
import { deliverAppRoutes, type AppRouteHandler } from './routes-delivery';

type Subscription = { remove(): void };
type RouteNativeModule = {
  pendingRoutes(): Promise<string>;
  acknowledgeRoute(id: string): Promise<void>;
  addListener(event: 'onRoute', listener: () => void): Subscription;
};
type Handler = AppRouteHandler;
const handlers = new Map<string, Handler>();
let listener: Subscription | undefined;
let activeListener: Subscription | undefined;
let pending: Promise<void> = Promise.resolve();
const acknowledged = new Set<string>();
function native(): RouteNativeModule | null {
  const module = requireOptionalNativeModule<RouteNativeModule>('ZoridShell');
  return module && typeof module.pendingRoutes === 'function' ? module : null;
}

/** Retry queued destinations, for example after a failed handler becomes ready. */
export function retryAppRoutes(): Promise<void> {
  const module = native();
  if (!module) return Promise.resolve();
  const next = pending.then(async () => {
    const routes = decodeRouteQueue(await module.pendingRoutes());
    await deliverAppRoutes(routes, handlers, id => module.acknowledgeRoute(id), acknowledged);
  });
  pending = next.catch(() => {});
  return next;
}

/** Register only after the downloaded app can navigate. Unhandled destinations
 * remain on disk across setup and OTA relaunch. No handler runs action code
 * implicitly: an app explicitly chooses what navigation to perform. */
export function registerAppRoutes(appId: string, handle: Handler['handle'], onError?: Handler['onError']): () => void {
  if (!isAppId(appId)) throw new Error('Invalid app ID.');
  if (handlers.has(appId)) throw new Error(`Routes are already registered for ${appId}.`);
  const registration = { handle, onError };
  handlers.set(appId, registration);
  if (!activeListener) {
    const module = native();
    if (module) listener = module.addListener('onRoute', () => { void retryAppRoutes().catch(error => onError?.(error)); });
    activeListener = AppState.addEventListener('change', state => {
      if (state === 'active') void retryAppRoutes().catch(error => onError?.(error));
    });
  }
  void retryAppRoutes().catch(error => onError?.(error));
  return () => {
    if (handlers.get(appId) !== registration) return;
    handlers.delete(appId);
    if (!handlers.size) {
      listener?.remove(); listener = undefined;
      activeListener?.remove(); activeListener = undefined;
    }
  };
}
