export type HapticImpactStyle = 'light' | 'medium' | 'heavy' | 'soft' | 'rigid';
export type HapticNotificationType = 'success' | 'warning' | 'error';
export type HapticKind = 'impact' | 'selection' | 'notification';
/** Logical points relative to the current presented foreground view. */
export type HapticPoint = { x: number; y: number };
export type HapticOptions = { at?: HapticPoint };
export type HapticImpactOptions = HapticOptions & { intensity?: number };
export type HapticsStatus = {
  available: boolean;
  location: boolean;
  /** Core Haptics' hardware capability; null when the installed bridge is absent. */
  supportsHaptics: boolean | null;
  reason?: string;
};

/** Optional methods let older ZoridShell binaries keep their other capabilities. */
export interface NativeHaptics {
  hapticsStatus?(): Promise<string>;
  impact?(style: HapticImpactStyle, intensity: number | null, pointJSON: string | null): Promise<void>;
  selection?(pointJSON: string | null): Promise<void>;
  notification?(type: HapticNotificationType, pointJSON: string | null): Promise<void>;
  prepareHaptics?(kind: HapticKind, style: HapticImpactStyle | null): Promise<void>;
  resetHaptics?(): Promise<void>;
}

const unavailableMessage = 'Install a Zorid iPhone build with the haptics bridge to use native feedback.';
const styles: HapticImpactStyle[] = ['light', 'medium', 'heavy', 'soft', 'rigid'];
function object(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).some(key => !allowed.includes(key))) {
    throw new Error('Invalid or unsupported haptic options.');
  }
}
function style(value: unknown): asserts value is HapticImpactStyle {
  if (!styles.includes(value as HapticImpactStyle)) throw new Error('Choose a light, medium, heavy, soft, or rigid haptic impact.');
}
function point(value: unknown): string | null {
  if (value === undefined) return null;
  object(value, ['x', 'y']);
  const { x, y } = value;
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
    throw new Error('Haptic coordinates must be finite numbers in logical points.');
  }
  // Snapshot before crossing the bridge; retain valid points outside the view.
  return JSON.stringify({ x, y });
}

export function createHapticsClient(native: NativeHaptics | null) {
  const available = typeof native?.hapticsStatus === 'function' && typeof native.impact === 'function'
    && typeof native.selection === 'function' && typeof native.notification === 'function';
  function requireNative(): NativeHaptics {
    if (!available || !native) throw new Error(unavailableMessage);
    return native;
  }

  function prepare(kind: 'impact', impactStyle?: HapticImpactStyle): Promise<void>;
  function prepare(kind: 'selection' | 'notification'): Promise<void>;
  async function prepare(kind: HapticKind, impactStyle?: HapticImpactStyle): Promise<void> {
    if (!['impact', 'selection', 'notification'].includes(kind)) throw new Error('Choose an impact, selection, or notification haptic generator.');
    if (kind === 'impact') { if (impactStyle !== undefined) style(impactStyle); }
    else if (impactStyle !== undefined) throw new Error('Only an impact haptic generator accepts a style.');
    const bridge = requireNative();
    if (typeof bridge.prepareHaptics !== 'function') throw new Error('Install a Zorid iPhone build with haptic preparation support.');
    await bridge.prepareHaptics(kind, impactStyle ?? null);
  }

  return {
    /** Installed bridge availability, not confirmation that a vibration occurred. */
    available,
    async status(): Promise<HapticsStatus> {
      if (!available) return { available: false, location: false, supportsHaptics: null, reason: unavailableMessage };
      const json = await requireNative().hapticsStatus!();
      let value: unknown;
      try { value = JSON.parse(json); } catch { throw new Error('Invalid native haptics status.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native haptics status.');
      const record = value as Record<string, unknown>;
      if (typeof record.available !== 'boolean' || typeof record.location !== 'boolean' || typeof record.supportsHaptics !== 'boolean') {
        throw new Error('Invalid native haptics status.');
      }
      return { available: record.available, location: record.location, supportsHaptics: record.supportsHaptics };
    },
    async impact(impactStyle: HapticImpactStyle, options: HapticImpactOptions = {}): Promise<void> {
      style(impactStyle); object(options, ['intensity', 'at']);
      const intensity = options.intensity;
      if (intensity !== undefined && (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity < 0 || intensity > 1)) {
        throw new Error('Haptic impact intensity must be between 0 and 1.');
      }
      const at = point(options.at);
      await requireNative().impact!(impactStyle, intensity ?? null, at);
    },
    async selection(options: HapticOptions = {}): Promise<void> {
      object(options, ['at']);
      const at = point(options.at);
      await requireNative().selection!(at);
    },
    async notification(type: HapticNotificationType, options: HapticOptions = {}): Promise<void> {
      if (!['success', 'warning', 'error'].includes(type)) throw new Error('Choose a success, warning, or error haptic notification.');
      object(options, ['at']);
      const at = point(options.at);
      await requireNative().notification!(type, at);
    },
    prepare,
    async reset(): Promise<void> {
      const bridge = requireNative();
      if (typeof bridge.resetHaptics !== 'function') throw new Error('Install a Zorid iPhone build with haptic generator reset support.');
      await bridge.resetHaptics();
    },
  };
}
