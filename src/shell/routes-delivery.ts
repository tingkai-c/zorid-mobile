import type { AppRoute } from './routes';

export type AppRouteHandler = {
  handle(route: AppRoute): void | Promise<void>;
  onError?(error: unknown): void;
};

/** Keep navigation separate from acknowledgment so a transient bridge failure
 * retries consumption without repeating a successful handler in this runtime. */
export async function deliverAppRoutes(
  routes: readonly AppRoute[],
  handlers: ReadonlyMap<string, AppRouteHandler>,
  acknowledge: (id: string) => Promise<void>,
  delivered: Set<string>,
): Promise<void> {
  const stillPending = new Set(routes.map(route => route.id));
  for (const id of delivered) if (!stillPending.has(id)) delivered.delete(id);
  for (const route of routes) {
    const handler = handlers.get(route.appId);
    if (!handler) continue;
    try {
      if (!delivered.has(route.id)) {
        await handler.handle(route);
        delivered.add(route.id);
      }
      await acknowledge(route.id);
    } catch (error) { handler.onError?.(error); }
  }
}
