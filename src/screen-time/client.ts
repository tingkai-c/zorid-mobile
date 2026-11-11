import { validateIdentifier } from '../actions/codec';
import type { ScreenTimeCommand } from '../actions/types';

export type ScreenTimeMode = 'blocklist' | 'allowlist';
export type ScreenTimeShieldResponse = 'close' | 'none' | 'stay' | 'defer' | 'openApp';
export const screenTimeBlurStyles = [
  'extraLight', 'light', 'dark', 'regular', 'prominent',
  'systemUltraThinMaterial', 'systemThinMaterial', 'systemMaterial', 'systemThickMaterial', 'systemChromeMaterial',
  'systemUltraThinMaterialLight', 'systemThinMaterialLight', 'systemMaterialLight', 'systemThickMaterialLight', 'systemChromeMaterialLight',
  'systemUltraThinMaterialDark', 'systemThinMaterialDark', 'systemMaterialDark', 'systemThickMaterialDark', 'systemChromeMaterialDark',
] as const;
export type ScreenTimeBlurStyle = typeof screenTimeBlurStyles[number];
export type ScreenTimeShieldColor = string | { light: string; dark: string };
export type ScreenTimeShieldLabel = { text: string; color: ScreenTimeShieldColor };
export type ScreenTimeShieldIcon = { systemName: string } | { pngBase64: string };
/** Apple's ShieldConfiguration fields, with native button responses kept separate. */
export type ScreenTimeShieldConfig = {
  backgroundBlurStyle?: ScreenTimeBlurStyle | null;
  backgroundColor?: ScreenTimeShieldColor | null;
  icon?: ScreenTimeShieldIcon | null;
  title?: ScreenTimeShieldLabel | null;
  subtitle?: ScreenTimeShieldLabel | null;
  primaryButtonLabel?: ScreenTimeShieldLabel | null;
  primaryButtonBackgroundColor?: ScreenTimeShieldColor | null;
  secondaryButtonLabel?: ScreenTimeShieldLabel | null;
  secondaryButtonSubmenuItems?: string[] | null;
  actions?: { primary?: ScreenTimeShieldResponse; secondary?: ScreenTimeShieldResponse; submenu?: ScreenTimeShieldResponse[] } | null;
};
export type ScreenTimePolicy = { id: string; mode: ScreenTimeMode; applicationCount: number; categoryCount: number; customShield?: boolean };
export type ScreenTimeStatus = {
  available: boolean;
  authorization: 'notDetermined' | 'denied' | 'approved';
  policies: ScreenTimePolicy[];
  active: { policyId: string; sessionId: string; endsAt: number } | null;
  shieldCapabilities?: { openApp: boolean; secondarySubmenu?: boolean };
  error?: string;
};
export interface NativeScreenTime {
  status(appId: string): Promise<string>;
  requestAuthorization(): Promise<void>;
  editPolicy(appId: string, policyId: string, mode: ScreenTimeMode): Promise<string>;
  deletePolicy(appId: string, policyId: string): Promise<void>;
  clear(appId: string): Promise<void>;
  apply(appId: string, commandJSON: string): Promise<void>;
  configureShield?(appId: string, policyId: string, configJSON: string | null): Promise<void>;
  getShield?(appId: string, policyId: string): Promise<string | null>;
}

const unavailableMessage = 'Install a Zorid iPhone build with Screen Time support to block apps.';
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function shieldObject(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Invalid or unsupported Screen Time shield configuration.');
  }
}
function shieldString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Screen Time shield text must be a string.');
  return value;
}
function shieldHex(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(value)) {
    throw new Error('Shield colors must use #RRGGBB or #RRGGBBAA.');
  }
  return value;
}
function shieldColor(value: unknown): ScreenTimeShieldColor {
  if (typeof value === 'string') return shieldHex(value);
  shieldObject(value, ['light', 'dark']);
  return { light: shieldHex(value.light), dark: shieldHex(value.dark) };
}
function shieldLabel(value: unknown): ScreenTimeShieldLabel {
  shieldObject(value, ['text', 'color']);
  return { text: shieldString(value.text), color: shieldColor(value.color) };
}
function shieldResponse(value: unknown): ScreenTimeShieldResponse {
  if (!['close', 'none', 'stay', 'defer', 'openApp'].includes(value as string)) {
    throw new Error('Unsupported Screen Time shield button response.');
  }
  return value as ScreenTimeShieldResponse;
}
function shieldPNG(value: unknown): string {
  const data = shieldString(value);
  if (!data.length || data.length > Math.ceil(128 * 1024 / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error('Shield PNG data must be base64 and at most 128 KiB decoded.');
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  let buffer = 0, bits = 0;
  for (const character of data) {
    if (character === '=') break;
    buffer = (buffer << 6) | alphabet.indexOf(character);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
  }
  if (bytes.length < 33 || bytes.length > 128 * 1024 || (bits && (buffer & ((1 << bits) - 1)))) {
    throw new Error('Invalid shield PNG data.');
  }
  const uint32 = (offset: number) => bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    || uint32(8) !== 13 || ![73, 72, 68, 82].every((byte, index) => bytes[index + 12] === byte)
    || uint32(16) < 1 || uint32(16) > 1024 || uint32(20) < 1 || uint32(20) > 1024) {
    throw new Error('Shield icons require a PNG with dimensions no larger than 1024 × 1024.');
  }
  return data;
}
function shieldIcon(value: unknown): ScreenTimeShieldIcon {
  shieldObject(value, ['systemName', 'pngBase64']);
  if (Object.keys(value).length !== 1) throw new Error('Choose an SF Symbol or a PNG shield icon.');
  if (Object.hasOwn(value, 'systemName')) return { systemName: shieldString(value.systemName) };
  return { pngBase64: shieldPNG(value.pngBase64) };
}
function serializeShieldConfig(value: ScreenTimeShieldConfig | null): string | null {
  if (value === null) return null;
  shieldObject(value, ['backgroundBlurStyle', 'backgroundColor', 'icon', 'title', 'subtitle', 'primaryButtonLabel',
    'primaryButtonBackgroundColor', 'secondaryButtonLabel', 'secondaryButtonSubmenuItems', 'actions']);
  const result: ScreenTimeShieldConfig = {};
  if (value.backgroundBlurStyle !== undefined) {
    if (value.backgroundBlurStyle !== null && !screenTimeBlurStyles.includes(value.backgroundBlurStyle)) throw new Error('Unsupported iOS shield blur style.');
    result.backgroundBlurStyle = value.backgroundBlurStyle;
  }
  for (const name of ['backgroundColor', 'primaryButtonBackgroundColor'] as const) {
    if (value[name] !== undefined) result[name] = value[name] === null ? null : shieldColor(value[name]);
  }
  for (const name of ['title', 'subtitle', 'primaryButtonLabel', 'secondaryButtonLabel'] as const) {
    if (value[name] !== undefined) result[name] = value[name] === null ? null : shieldLabel(value[name]);
  }
  if (value.icon !== undefined) result.icon = value.icon === null ? null : shieldIcon(value.icon);
  if (value.secondaryButtonSubmenuItems !== undefined) {
    const items = value.secondaryButtonSubmenuItems;
    if (items !== null && (!Array.isArray(items) || items.length < 1 || items.length > 3)) throw new Error('Shield submenu requires 1–3 items.');
    result.secondaryButtonSubmenuItems = items === null ? null : Array.from(items, shieldString);
  }
  if (value.actions !== undefined) {
    if (value.actions === null) result.actions = null;
    else {
      shieldObject(value.actions, ['primary', 'secondary', 'submenu']);
      const actions: NonNullable<ScreenTimeShieldConfig['actions']> = {};
      if (value.actions.primary !== undefined) actions.primary = shieldResponse(value.actions.primary);
      if (value.actions.secondary !== undefined) actions.secondary = shieldResponse(value.actions.secondary);
      if (value.actions.submenu !== undefined) {
        if (!Array.isArray(value.actions.submenu) || value.actions.submenu.length > 3) throw new Error('Invalid shield submenu responses.');
        actions.submenu = Array.from(value.actions.submenu, shieldResponse);
      }
      result.actions = actions;
    }
  }
  if (result.actions?.submenu !== undefined && (!result.secondaryButtonSubmenuItems
    || result.secondaryButtonSubmenuItems.length !== result.actions.submenu.length)) {
    throw new Error('Shield submenu items and responses must have matching lengths.');
  }
  const json = JSON.stringify(result);
  let byteCount = 0;
  for (const character of json) {
    const point = character.codePointAt(0)!;
    byteCount += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (byteCount > 256 * 1024) throw new Error('Shield configuration exceeds the 256 KiB transport limit.');
  }
  return json;
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
      || !count(policy.applicationCount) || !count(policy.categoryCount)
      || (policy.customShield !== undefined && typeof policy.customShield !== 'boolean')) throw new Error('Invalid native Screen Time policy.');
    validateIdentifier(policy.id, 'Screen Time policy ID');
    return { id: policy.id, mode: policy.mode as ScreenTimeMode,
      applicationCount: policy.applicationCount, categoryCount: policy.categoryCount,
      ...(typeof policy.customShield === 'boolean' ? { customShield: policy.customShield } : {}) };
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
  let shieldCapabilities: ScreenTimeStatus['shieldCapabilities'];
  if (value.shieldCapabilities !== undefined) {
    if (!object(value.shieldCapabilities) || typeof value.shieldCapabilities.openApp !== 'boolean') {
      throw new Error('Invalid native Screen Time shield capabilities.');
    }
    if (value.shieldCapabilities.secondarySubmenu !== undefined && typeof value.shieldCapabilities.secondarySubmenu !== 'boolean') {
      throw new Error('Invalid native Screen Time shield capabilities.');
    }
    shieldCapabilities = { openApp: value.shieldCapabilities.openApp,
      ...(typeof value.shieldCapabilities.secondarySubmenu === 'boolean' ? { secondarySubmenu: value.shieldCapabilities.secondarySubmenu } : {}) };
  }
  return { available: value.available, authorization: value.authorization as ScreenTimeStatus['authorization'], policies, active,
    ...(shieldCapabilities ? { shieldCapabilities } : {}),
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
    shieldAvailable: typeof native?.configureShield === 'function',
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
    configureShield(appId: string, policyId: string, config: ScreenTimeShieldConfig | null): Promise<ScreenTimeStatus> {
      validateIdentifier(appId, 'App ID'); validateIdentifier(policyId, 'Screen Time policy ID');
      const json = serializeShieldConfig(config);
      return serialized(async () => {
        const bridge = requireNative();
        if (!bridge.configureShield) throw new Error('Install a Zorid iPhone build with custom Screen Time shields.');
        await bridge.configureShield(appId, policyId, json);
        return status(appId);
      });
    },
    getShield(appId: string, policyId: string): Promise<ScreenTimeShieldConfig | null> {
      validateIdentifier(appId, 'App ID'); validateIdentifier(policyId, 'Screen Time policy ID');
      return serialized(async () => {
        const bridge = requireNative();
        if (!bridge.getShield) throw new Error('Install a Zorid iPhone build that can read custom Screen Time shields.');
        const raw = await bridge.getShield(appId, policyId);
        if (raw === null) return null;
        const json = serializeShieldConfig(JSON.parse(raw) as ScreenTimeShieldConfig | null);
        return json === null ? null : JSON.parse(json) as ScreenTimeShieldConfig;
      });
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
