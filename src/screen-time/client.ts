import { validateIdentifier } from '../actions/codec';
import type { ScreenTimeCommand } from '../actions/types';

export type ScreenTimeMode = 'blocklist' | 'allowlist';
export type ScreenTimePolicy = { id: string; mode: ScreenTimeMode; applicationCount: number; categoryCount: number };
export type ScreenTimeStatus = {
  available: boolean;
  authorization: 'notDetermined' | 'denied' | 'approved';
  policies: ScreenTimePolicy[];
  active: { policyId: string; sessionId: string; endsAt: number } | null;
  error?: string;
};
export interface NativeScreenTime {
  status(appId: string): Promise<string>;
  requestAuthorization(): Promise<void>;
  editPolicy(appId: string, policyId: string, mode: ScreenTimeMode): Promise<string>;
  deletePolicy(appId: string, policyId: string): Promise<void>;
  clear(appId: string): Promise<void>;
  apply(appId: string, commandJSON: string): Promise<void>;
}

const unavailableMessage = 'Install a Zorid iPhone build with Screen Time support to block apps.';
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
/** Keep opaque selection tokens inside iOS, including when native adds fields. */
export function parseScreenTimeStatus(json: string): ScreenTimeStatus {
  const value: unknown = JSON.parse(json);
  if (!object(value) || typeof value.available !== 'boolean'
    || !['notDetermined', 'denied', 'approved'].includes(value.authorization as string)
    || !Array.isArray(value.policies) || value.policies.length > 50
    || (value.error !== undefined && typeof value.error !== 'string')) throw new Error('Invalid native Screen Time response.');
  const policies = value.policies.map(policy => {
    if (!object(policy) || !['blocklist', 'allowlist'].includes(policy.mode as string)
      || !count(policy.applicationCount) || !count(policy.categoryCount)) throw new Error('Invalid native Screen Time policy.');
    validateIdentifier(policy.id, 'Screen Time policy ID');
    return { id: policy.id, mode: policy.mode as ScreenTimeMode,
      applicationCount: policy.applicationCount, categoryCount: policy.categoryCount };
  });
  if (new Set(policies.map(policy => policy.id)).size !== policies.length) throw new Error('Duplicate native Screen Time policy.');
  let active: ScreenTimeStatus['active'] = null;
  if (value.active !== null) {
    if (!object(value.active) || typeof value.active.endsAt !== 'number' || !Number.isFinite(value.active.endsAt)) {
      throw new Error('Invalid native Screen Time session.');
    }
    validateIdentifier(value.active.policyId, 'Screen Time policy ID');
    validateIdentifier(value.active.sessionId, 'Screen Time session ID');
    active = { policyId: value.active.policyId, sessionId: value.active.sessionId, endsAt: value.active.endsAt };
  }
  return { available: value.available, authorization: value.authorization as ScreenTimeStatus['authorization'], policies, active,
    ...(typeof value.error === 'string' ? { error: value.error } : {}) };
}

export function createScreenTimeClient(native: NativeScreenTime | null) {
  let queue: Promise<unknown> = Promise.resolve();
  function requireNative() {
    if (!native) throw new Error(unavailableMessage);
    return native;
  }
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }
  async function status(appId: string): Promise<ScreenTimeStatus> {
    validateIdentifier(appId, 'App ID');
    if (!native) return { available: false, authorization: 'notDetermined', policies: [], active: null, error: unavailableMessage };
    return parseScreenTimeStatus(await native.status(appId));
  }
  return {
    available: native !== null,
    status,
    requestAuthorization(appId: string): Promise<ScreenTimeStatus> {
      validateIdentifier(appId, 'App ID');
      return serialized(async () => { await requireNative().requestAuthorization(); return status(appId); });
    },
    editPolicy(appId: string, policyId: string, mode: ScreenTimeMode): Promise<ScreenTimeStatus> {
      validateIdentifier(appId, 'App ID'); validateIdentifier(policyId, 'Screen Time policy ID');
      if (mode !== 'blocklist' && mode !== 'allowlist') throw new Error('Choose a blocklist or allowlist.');
      return serialized(async () => parseScreenTimeStatus(await requireNative().editPolicy(appId, policyId, mode)));
    },
    deletePolicy(appId: string, policyId: string): Promise<ScreenTimeStatus> {
      validateIdentifier(appId, 'App ID'); validateIdentifier(policyId, 'Screen Time policy ID');
      return serialized(async () => { await requireNative().deletePolicy(appId, policyId); return status(appId); });
    },
    clear(appId: string): Promise<ScreenTimeStatus> {
      validateIdentifier(appId, 'App ID');
      return serialized(async () => { await requireNative().clear(appId); return status(appId); });
    },
    apply(appId: string, command: ScreenTimeCommand): Promise<ScreenTimeStatus> {
      validateIdentifier(appId, 'App ID');
      if (!object(command)) throw new Error('Invalid Screen Time command.');
      const keys = Object.keys(command);
      if ('clear' in command) {
        if (command.clear !== true || keys.length !== 1) throw new Error('Invalid Screen Time clear command.');
      } else {
        validateIdentifier(command.policyId, 'Screen Time policy ID');
        validateIdentifier(command.sessionId, 'Screen Time session ID');
        if (keys.length !== 3 || typeof command.endsAt !== 'number' || !Number.isSafeInteger(command.endsAt)
          || command.endsAt <= 0 || command.endsAt > Date.now() + 24 * 60 * 60_000) {
          throw new Error('Screen Time needs a whole-millisecond deadline within the next 24 hours.');
        }
      }
      // Capture the invocation before queuing; callers may reuse their objects.
      const json = JSON.stringify(command);
      return serialized(async () => { await requireNative().apply(appId, json); return status(appId); });
    },
  };
}
