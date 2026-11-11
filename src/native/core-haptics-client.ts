export type CoreHapticJSON = null | boolean | number | string | CoreHapticJSON[] | { [key: string]: CoreHapticJSON };
/** Apple AHAP dictionary. Native Core Haptics validates the AHAP schema. */
export type CoreHapticPattern = { [key: string]: CoreHapticJSON };
export type CoreHapticParameterID = 'HapticIntensityControl' | 'HapticSharpnessControl'
  | 'HapticAttackTimeControl' | 'HapticDecayTimeControl' | 'HapticReleaseTimeControl';
export type CoreHapticParameter = { id: CoreHapticParameterID; value: number };
export type CoreHapticControlPoint = { time: number; value: number };
export type CoreHapticTiming = { delay?: number };
export type CoreHapticConfiguration = { loopEnabled?: boolean; loopEnd?: number; playbackRate?: number; isMuted?: boolean };
export type CoreHapticCommand =
  | ({ type: 'start' | 'stop' | 'pause' | 'resume' } & CoreHapticTiming)
  | { type: 'seek'; offset: number }
  | ({ type: 'configure' } & CoreHapticConfiguration)
  | ({ type: 'parameters'; parameters: CoreHapticParameter[] } & CoreHapticTiming)
  | ({ type: 'curve'; id: CoreHapticParameterID; points: CoreHapticControlPoint[] } & CoreHapticTiming)
  | { type: 'dispose' };
export type CoreHapticPlayerInfo = { id: string; duration: number };
export type CoreHapticPlayerStatus = CoreHapticPlayerInfo & {
  state: 'ready' | 'scheduled' | 'playing' | 'paused' | 'stopped' | 'finished';
  loopEnabled: boolean; loopEnd: number; playbackRate: number; isMuted: boolean;
  lastCommand?: string | null; stateSource?: 'command' | 'completion';
};
export type CoreHapticsStatus = {
  available: boolean; supportsHaptics: boolean | null; supportsAudio: boolean | null; audioResources: false;
  engine: 'unavailable' | 'idle' | 'running' | 'stopped' | 'reset' | 'failed'; generation: number | null;
  stoppedReason: string | null; lastError: string | null; players: CoreHapticPlayerStatus[]; reason?: string;
  stateBasis?: 'commandsAndCallbacks';
};
export interface NativeCoreHaptics {
  coreHapticsStatus?(): Promise<string>;
  coreHapticsCreate?(patternJSON: string): Promise<string>;
  coreHapticsCommand?(playerId: string, commandJSON: string): Promise<void>;
  coreHapticsStart?(): Promise<void>;
  coreHapticsStop?(): Promise<void>;
  coreHapticsReset?(): Promise<void>;
}

const unavailableMessage = 'Install a Zorid iPhone build with the Core Haptics bridge to play custom patterns.';
const parameterIDs: CoreHapticParameterID[] = ['HapticIntensityControl', 'HapticSharpnessControl',
  'HapticAttackTimeControl', 'HapticDecayTimeControl', 'HapticReleaseTimeControl'];
function object(value: unknown, keys?: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length
    || (keys && Object.getOwnPropertyNames(value).some(key => !keys.includes(key)))) {
    throw new Error('Invalid or unsupported Core Haptics options.');
  }
}
function number(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Core Haptics values must be finite numbers between ${min} and ${max}.`);
  }
}
function playbackRate(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isFinite(Math.fround(value)) || Math.fround(value) <= 0) {
    throw new Error('Core Haptics playback rate must be positive and representable as a finite native Float.');
  }
}
function playerID(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) {
    throw new Error('Core Haptics requires a native player ID.');
  }
}
function parameterID(value: unknown): asserts value is CoreHapticParameterID {
  if (!parameterIDs.includes(value as CoreHapticParameterID)) throw new Error('Unsupported Core Haptics dynamic parameter.');
}
function parameterValue(id: CoreHapticParameterID, value: unknown) { number(value, id === 'HapticIntensityControl' ? 0 : -1, 1); }
function jsonValue(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 64) throw new Error('Core Haptics JSON is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') throw new Error('Core Haptics requires finite JSON values.');
  if (seen.has(value)) throw new Error('Core Haptics JSON cannot contain cycles.');
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) {
      throw new Error('Core Haptics requires plain JSON arrays.');
    }
    for (let i = 0; i < value.length; i++) jsonValue(value[i], seen, depth + 1);
  } else {
    object(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Core Haptics requires plain JSON properties.');
      jsonValue(descriptor.value, seen, depth + 1);
    }
  }
  seen.delete(value);
}
function snapshot(value: unknown): string {
  jsonValue(value);
  const json = JSON.stringify(value);
  let bytes = 0;
  for (const character of json) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > 256 * 1024) throw new Error('Core Haptics JSON exceeds the 256 KiB transport limit.');
  }
  return json;
}
function timing(value: unknown): CoreHapticTiming {
  object(value, ['delay']);
  if (value.delay !== undefined) number(value.delay, 0, 60);
  return value.delay === undefined ? {} : { delay: value.delay };
}
function serializeCommand(value: CoreHapticCommand): string {
  object(value);
  const type = value.type;
  switch (type) {
    case 'start': case 'stop': case 'pause': case 'resume':
      object(value, ['type', 'delay']);
      return snapshot({ type, ...timing(value.delay === undefined ? {} : { delay: value.delay }) });
    case 'seek': object(value, ['type', 'offset']); number(value.offset, 0, 120); break;
    case 'configure':
      object(value, ['type', 'loopEnabled', 'loopEnd', 'playbackRate', 'isMuted']);
      for (const key of ['loopEnabled', 'isMuted'] as const) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('Core Haptics configuration flags must be boolean.');
      }
      if (value.loopEnd !== undefined) number(value.loopEnd, 0, 120);
      if (value.playbackRate !== undefined) playbackRate(value.playbackRate);
      return snapshot({ type, ...(value.loopEnabled === undefined ? {} : { loopEnabled: value.loopEnabled }),
        ...(value.loopEnd === undefined ? {} : { loopEnd: value.loopEnd }),
        ...(value.playbackRate === undefined ? {} : { playbackRate: value.playbackRate }),
        ...(value.isMuted === undefined ? {} : { isMuted: value.isMuted }) });
    case 'parameters':
      object(value, ['type', 'parameters', 'delay']);
      if (!Array.isArray(value.parameters) || value.parameters.length < 1 || value.parameters.length > 1024) throw new Error('Provide 1–1024 dynamic parameters.');
      for (const parameter of value.parameters) {
        object(parameter, ['id', 'value']); parameterID(parameter.id); parameterValue(parameter.id, parameter.value);
      }
      return snapshot({ type, parameters: value.parameters, ...timing(value.delay === undefined ? {} : { delay: value.delay }) });
    case 'curve': {
      object(value, ['type', 'id', 'points', 'delay']); parameterID(value.id);
      if (!Array.isArray(value.points) || value.points.length < 1 || value.points.length > 1024) throw new Error('Provide 1–1024 curve control points.');
      let previous = -1;
      for (const point of value.points) {
        object(point, ['time', 'value']); number(point.time, 0, 120); parameterValue(value.id, point.value);
        if (point.time < previous) throw new Error('Core Haptics control points must be sorted by time.');
        previous = point.time;
      }
      return snapshot({ type, id: value.id, points: value.points, ...timing(value.delay === undefined ? {} : { delay: value.delay }) });
    }
    case 'dispose': object(value, ['type']); break;
    default: throw new Error('Unsupported Core Haptics player command.');
  }
  return snapshot(value);
}
function parseJSON(json: string): unknown {
  try { return JSON.parse(json); } catch { throw new Error('Invalid native Core Haptics response.'); }
}
function playerInfo(value: unknown): CoreHapticPlayerInfo {
  object(value); playerID(value.id); number(value.duration, 0, 120);
  return { id: value.id, duration: value.duration };
}
function parseStatus(json: string): CoreHapticsStatus {
  const value = parseJSON(json); object(value);
  if (value.available !== true || typeof value.supportsHaptics !== 'boolean' || typeof value.supportsAudio !== 'boolean'
    || value.audioResources !== false || !['idle', 'running', 'stopped', 'reset', 'failed'].includes(value.engine as string)
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0
    || (value.stoppedReason !== null && typeof value.stoppedReason !== 'string')
    || (value.lastError !== null && typeof value.lastError !== 'string') || !Array.isArray(value.players)
    || (value.stateBasis !== undefined && value.stateBasis !== 'commandsAndCallbacks')) {
    throw new Error('Invalid native Core Haptics status.');
  }
  const players = value.players.map(player => {
    const info = playerInfo(player); object(player);
    if (!['ready', 'scheduled', 'playing', 'paused', 'stopped', 'finished'].includes(player.state as string)
      || typeof player.loopEnabled !== 'boolean' || typeof player.isMuted !== 'boolean'
      || (player.lastCommand !== undefined && player.lastCommand !== null && typeof player.lastCommand !== 'string')
      || (player.stateSource !== undefined && player.stateSource !== 'command' && player.stateSource !== 'completion')) throw new Error('Invalid native Core Haptics player status.');
    number(player.loopEnd, 0, 120); playbackRate(player.playbackRate);
    return { ...info, state: player.state, loopEnabled: player.loopEnabled, loopEnd: player.loopEnd,
      playbackRate: player.playbackRate, isMuted: player.isMuted,
      ...(player.lastCommand === undefined ? {} : { lastCommand: player.lastCommand }),
      ...(player.stateSource === undefined ? {} : { stateSource: player.stateSource }) } as CoreHapticPlayerStatus;
  });
  return { available: true, supportsHaptics: value.supportsHaptics, supportsAudio: value.supportsAudio, audioResources: false,
    engine: value.engine as CoreHapticsStatus['engine'], generation: value.generation as number,
    stoppedReason: value.stoppedReason as string | null, lastError: value.lastError as string | null, players,
    ...(value.stateBasis === undefined ? {} : { stateBasis: value.stateBasis }) };
}

export function createCoreHapticsClient(native: NativeCoreHaptics | null) {
  const available = !!native && ['coreHapticsStatus', 'coreHapticsCreate', 'coreHapticsCommand',
    'coreHapticsStart', 'coreHapticsStop', 'coreHapticsReset'].every(key => typeof native[key as keyof NativeCoreHaptics] === 'function');
  function requireNative(): NativeCoreHaptics {
    if (!available || !native) throw new Error(unavailableMessage);
    return native;
  }
  async function command(id: string, value: CoreHapticCommand) {
    playerID(id);
    const json = serializeCommand(value);
    await requireNative().coreHapticsCommand!(id, json);
  }
  return {
    /** Installed bridge availability, independent of physical haptics support. */
    available,
    async status(): Promise<CoreHapticsStatus> {
      if (!available) return { available: false, supportsHaptics: null, supportsAudio: null, audioResources: false,
        engine: 'unavailable', generation: null, stoppedReason: null, lastError: null, players: [], reason: unavailableMessage };
      return parseStatus(await requireNative().coreHapticsStatus!());
    },
    async start(): Promise<void> { await requireNative().coreHapticsStart!(); },
    async stop(): Promise<void> { await requireNative().coreHapticsStop!(); },
    async reset(): Promise<void> { await requireNative().coreHapticsReset!(); },
    command,
    async createPlayer(pattern: CoreHapticPattern) {
      object(pattern);
      const json = snapshot(pattern);
      const info = playerInfo(parseJSON(await requireNative().coreHapticsCreate!(json)));
      return {
        ...info,
        start: async (options: CoreHapticTiming = {}) => command(info.id, { type: 'start', ...timing(options) }),
        stop: async (options: CoreHapticTiming = {}) => command(info.id, { type: 'stop', ...timing(options) }),
        pause: async (options: CoreHapticTiming = {}) => command(info.id, { type: 'pause', ...timing(options) }),
        resume: async (options: CoreHapticTiming = {}) => command(info.id, { type: 'resume', ...timing(options) }),
        seek: (offset: number) => command(info.id, { type: 'seek', offset }),
        configure: async (options: CoreHapticConfiguration) => { object(options, ['loopEnabled', 'loopEnd', 'playbackRate', 'isMuted']); return command(info.id, { type: 'configure', ...options }); },
        sendParameters: async (parameters: CoreHapticParameter[], options: CoreHapticTiming = {}) => command(info.id, { type: 'parameters', parameters, ...timing(options) }),
        scheduleCurve: async (id: CoreHapticParameterID, points: CoreHapticControlPoint[], options: CoreHapticTiming = {}) => command(info.id, { type: 'curve', id, points, ...timing(options) }),
        dispose: () => command(info.id, { type: 'dispose' }),
      };
    },
  };
}
export type CoreHapticPlayer = Awaited<ReturnType<ReturnType<typeof createCoreHapticsClient>['createPlayer']>>;
