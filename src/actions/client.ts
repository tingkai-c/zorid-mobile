import { serializeActionBundle, serializeActionRequest, validateIdentifier } from './codec';
import type { ActionBundle, ActionRequest, ActionResult, JsonValue, NativeActions, NativeActionSurfaces, OutboxEntry } from './types';

export function createActionClient(native: NativeActions | null, surfaces: NativeActionSurfaces | null = null,
  makeInvocationId?: () => string) {
  const installed = new Map<string, string>();
  let pending: Promise<unknown> = Promise.resolve();
  function requireNative(): NativeActions {
    if (!native) throw new Error('Install a Zorid binary with the action bridge to use native actions.');
    return native;
  }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.then(operation, operation);
    pending = next.then(() => undefined, () => undefined);
    return next;
  }
  async function flushEffects(appId: string): Promise<number> {
    validateIdentifier(appId, 'App ID');
    const bridge = requireNative();
    if (surfaces?.flushZoridActionEffects) return surfaces.flushZoridActionEffects(appId);
    const effects: unknown = JSON.parse(await bridge.pendingEffects(appId));
    if (!Array.isArray(effects)) throw new Error('Invalid native pending effects response.');
    if (effects.length) throw new Error('Native surface updates are pending. Install a Zorid binary with the surface adapter.');
    return 0;
  }
  function dispatch<T = JsonValue>(request: ActionRequest): Promise<ActionResult<T>> {
    const encoded = serializeActionRequest(request);
    const { appId, invocationId } = request;
    return serialize(async () => {
      const response: unknown = JSON.parse(await requireNative().dispatch(encoded));
      if (!response || typeof response !== 'object') throw new Error('Invalid native action response.');
      const result = response as ActionResult<T>;
      if (result.invocationId !== invocationId || typeof result.duplicate !== 'boolean'
        || !Array.isArray(result.effects) || !Object.hasOwn(result, 'result')) throw new Error('Invalid native action response.');
      try { await flushEffects(appId); }
      catch (error) { return { ...result, surfaceError: error instanceof Error ? error.message : 'Native surfaces could not refresh. Changes are saved.' }; }
      return result;
    });
  }
  return {
    available: native !== null,
    install(bundle: ActionBundle): Promise<void> {
      const encoded = serializeActionBundle(bundle);
      const appId = bundle.appId;
      return serialize(async () => {
        if (installed.get(appId) === encoded) return;
        await requireNative().installBundle(encoded);
        installed.set(appId, encoded);
      });
    },
    dispatch,
    invoke<T = JsonValue>(appId: string, actionId: string, args: JsonValue,
      options: { invocationId?: string; bundleVersion?: string } = {}): Promise<ActionResult<T>> {
      const invocationId = options.invocationId ?? makeInvocationId?.();
      if (!invocationId) throw new Error('An invocation ID is required to safely execute an action.');
      return dispatch<T>({ appId, actionId, invocationId, args, bundleVersion: options.bundleVersion });
    },
    flushEffects,
    async readOutbox(appId: string): Promise<OutboxEntry[]> {
      validateIdentifier(appId, 'App ID');
      const value: unknown = JSON.parse(await requireNative().readOutbox(appId));
      if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object'
        || typeof item.id !== 'string' || item.appId !== appId || typeof item.type !== 'string'
        || !Number.isFinite(item.createdAt) || !Object.hasOwn(item, 'payload'))) throw new Error('Invalid native outbox response.');
      return value as OutboxEntry[];
    },
    async acknowledgeOutbox(appId: string, ids: string[]): Promise<void> {
      validateIdentifier(appId, 'App ID');
      if (!Array.isArray(ids) || ids.length > 256) throw new Error('Acknowledge at most 256 outbox entries at once.');
      ids.forEach(id => validateIdentifier(id, 'Outbox ID', 128));
      await requireNative().acknowledgeOutbox(appId, ids);
    },
  };
}
export type ActionClient = ReturnType<typeof createActionClient>;
