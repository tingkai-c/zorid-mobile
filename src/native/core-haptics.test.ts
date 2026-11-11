import { expect, test } from 'bun:test';
import { createCoreHapticsClient, type NativeCoreHaptics, type CoreHapticCommand,
  type CoreHapticPattern, type CoreHapticParameter, type CoreHapticControlPoint, type CoreHapticsStatus } from './core-haptics-client';

const id = '92d22593-8af6-4322-9cd0-13f037e2b937';
function pattern(): CoreHapticPattern {
  return { Version: 1, Pattern: [{ Event: { Time: 0, EventType: 'HapticContinuous', EventDuration: 0.5,
    EventParameters: [{ ParameterID: 'HapticIntensity', ParameterValue: 0.8 }, { ParameterID: 'HapticSharpness', ParameterValue: 0.5 }] } }] };
}
function status(): CoreHapticsStatus {
  return { available: true, supportsHaptics: true, supportsAudio: true, audioResources: false,
    engine: 'running', generation: 1, stoppedReason: null, lastError: null,
    players: [{ id, duration: 0.5, state: 'playing', loopEnabled: false, loopEnd: 0, playbackRate: 1, isMuted: false }] };
}
function native(overrides: Partial<NativeCoreHaptics> = {}): NativeCoreHaptics {
  return { async coreHapticsStatus() { return JSON.stringify(status()); },
    async coreHapticsCreate() { return JSON.stringify({ id, duration: 0.5 }); },
    async coreHapticsCommand() {}, async coreHapticsStart() {}, async coreHapticsStop() {}, async coreHapticsReset() {}, ...overrides };
}

test('missing or partial bridges provide explicit capability and upgrade errors', async () => {
  for (const bridge of [null, {}, native({ coreHapticsCommand: undefined })]) {
    const client = createCoreHapticsClient(bridge);
    expect(client.available).toBe(false);
    expect(await client.status()).toEqual({ available: false, supportsHaptics: null, supportsAudio: null, audioResources: false,
      engine: 'unavailable', generation: null, stoppedReason: null, lastError: null, players: [],
      reason: 'Install a Zorid iPhone build with the Core Haptics bridge to play custom patterns.' });
    for (const call of [() => client.start(), () => client.stop(), () => client.reset(),
      () => client.createPlayer(pattern()), () => client.command(id, { type: 'start' })]) {
      await expect(call()).rejects.toThrow('iPhone build with the Core Haptics bridge');
    }
  }
});

test('AHAP and all advanced player operations cross the bridge without simulated playback state', async () => {
  const calls: unknown[][] = [];
  const client = createCoreHapticsClient(native({ async coreHapticsCreate(json) {
    calls.push(['create', JSON.parse(json)]); return JSON.stringify({ id, duration: 0.5 });
  }, async coreHapticsCommand(playerId, json) { calls.push(['command', playerId, JSON.parse(json)]); },
  async coreHapticsStart() { calls.push(['engineStart']); }, async coreHapticsStop() { calls.push(['engineStop']); },
  async coreHapticsReset() { calls.push(['engineReset']); } }));
  await client.start(); const player = await client.createPlayer(pattern());
  expect({ id: player.id, duration: player.duration }).toEqual({ id, duration: 0.5 });
  await player.start(); await player.pause({ delay: 0.1 }); await player.resume({ delay: 0 }); await player.seek(0.2);
  await player.configure({ loopEnabled: true, loopEnd: 0.4, playbackRate: 0.5, isMuted: false });
  await player.sendParameters([{ id: 'HapticIntensityControl', value: 0.6 }]);
  await player.scheduleCurve('HapticSharpnessControl', [{ time: 0, value: -1 }, { time: 0.2, value: 1 }], { delay: 0.1 });
  await player.stop({ delay: 0.4 }); await player.dispose(); await client.stop(); await client.reset();
  expect(calls).toEqual([
    ['engineStart'], ['create', pattern()], ['command', id, { type: 'start' }],
    ['command', id, { type: 'pause', delay: 0.1 }], ['command', id, { type: 'resume', delay: 0 }],
    ['command', id, { type: 'seek', offset: 0.2 }],
    ['command', id, { type: 'configure', loopEnabled: true, loopEnd: 0.4, playbackRate: 0.5, isMuted: false }],
    ['command', id, { type: 'parameters', parameters: [{ id: 'HapticIntensityControl', value: 0.6 }] }],
    ['command', id, { type: 'curve', id: 'HapticSharpnessControl', points: [{ time: 0, value: -1 }, { time: 0.2, value: 1 }], delay: 0.1 }],
    ['command', id, { type: 'stop', delay: 0.4 }], ['command', id, { type: 'dispose' }], ['engineStop'], ['engineReset'],
  ]);
});

test('invalid commands, timing, configuration and parameter curves cannot reach native', async () => {
  let calls = 0;
  const client = createCoreHapticsClient(native({ async coreHapticsCommand() { calls++; } }));
  const invalid: unknown[] = [null, [], {}, { type: 'unknown' }, { type: 'start', extra: true },
    { type: 'start', delay: -1 }, { type: 'resume', delay: 60.01 }, { type: 'stop', delay: NaN },
    { type: 'pause', delay: Infinity }, { type: 'seek', offset: -1 }, { type: 'seek', offset: 121 },
    { type: 'seek', offset: '1' }, { type: 'configure', playbackRate: 0 }, { type: 'configure', playbackRate: -1 },
    { type: 'configure', playbackRate: Number.MIN_VALUE }, { type: 'configure', playbackRate: Number.MAX_VALUE },
    { type: 'configure', loopEnd: -1 }, { type: 'configure', isMuted: 1 }, { type: 'configure', loopEnabled: null },
    { type: 'dispose', delay: 1 }, { type: 'parameters', parameters: [] },
    { type: 'parameters', parameters: [{ id: 'Unknown', value: 0.5 }] },
    { type: 'parameters', parameters: [{ id: 'HapticIntensityControl', value: -0.1 }] },
    { type: 'parameters', parameters: [{ id: 'HapticSharpnessControl', value: -1.1 }] },
    { type: 'parameters', parameters: [{ id: 'HapticAttackTimeControl', value: 0, extra: true }] },
    { type: 'parameters', parameters: Array(1) },
    { type: 'parameters', parameters: Array.from({ length: 1025 }, () => ({ id: 'HapticIntensityControl', value: 1 })) },
    { type: 'curve', id: 'HapticIntensityControl', points: [] },
    { type: 'curve', id: 'HapticIntensityControl', points: [{ time: 0, value: -1 }] },
    { type: 'curve', id: 'HapticSharpnessControl', points: [{ time: 1, value: 0 }, { time: 0, value: 0 }] },
    { type: 'curve', id: 'HapticSharpnessControl', points: [{ time: -1, value: 0 }] },
    { type: 'curve', id: 'HapticSharpnessControl', points: [{ time: 0, value: Infinity }] },
    { type: 'curve', id: 'HapticSharpnessControl', points: [{ time: 0, value: 0, extra: true }] }];
  for (const command of invalid) await expect(client.command(id, command as CoreHapticCommand)).rejects.toThrow();
  for (const playerId of ['', 'not-native', '../player', null]) {
    await expect(client.command(playerId as string, { type: 'start' })).rejects.toThrow('native player ID');
  }
  const player = await client.createPlayer(pattern());
  await expect(player.start({ extra: true } as never)).rejects.toThrow();
  await expect(player.configure({ type: 'dispose' } as never)).rejects.toThrow();
  expect(calls).toBe(0);
});

test('playback rates follow native positive Float limits without an artificial speed range', async () => {
  const rates: number[] = [];
  const client = createCoreHapticsClient(native({ async coreHapticsCommand(_id, json) { rates.push(JSON.parse(json).playbackRate); } }));
  const player = await client.createPlayer(pattern());
  for (const playbackRate of [0.01, 1000, Math.fround(1e-40), Math.fround(3e38)]) await player.configure({ playbackRate });
  expect(rates).toEqual([0.01, 1000, Math.fround(1e-40), Math.fround(3e38)]);
});

test('AHAP transport rejects non-JSON, cycles and UTF-8 oversized payloads before native validation', async () => {
  let calls = 0;
  const client = createCoreHapticsClient(native({ async coreHapticsCreate() { calls++; return '{}'; } }));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const invalid: unknown[] = [null, [], new Date(), { value: undefined }, { value: NaN }, { value: Infinity },
    { value: 1n }, { value() {} }, cycle, { [Symbol('hidden')]: true }, { Pattern: Array(1) },
    Object.defineProperty({}, 'hidden', { value: true }), { get Pattern() { return []; } },
    { Metadata: '🦔'.repeat(70 * 1024) }];
  for (const value of invalid) await expect(client.createPlayer(value as CoreHapticPattern)).rejects.toThrow();
  expect(calls).toBe(0);
});

test('patterns, parameter lists and curves are snapshotted before asynchronous completion', async () => {
  let finish!: () => void;
  let captured = '';
  const bridge = native({ async coreHapticsCreate(json) {
    captured = json; await new Promise<void>(resolve => { finish = resolve; }); return JSON.stringify({ id, duration: 0.5 });
  } });
  const client = createCoreHapticsClient(bridge);
  const ahap = pattern(); const pending = client.createPlayer(ahap); const expected = pattern(); ahap.Pattern = [];
  expect(JSON.parse(captured)).toEqual(expected); finish(); const player = await pending;
  const commands: string[] = [];
  bridge.coreHapticsCommand = async (_id, json) => { commands.push(json); };
  const parameters: CoreHapticParameter[] = [{ id: 'HapticIntensityControl', value: 0.5 }];
  const points: CoreHapticControlPoint[] = [{ time: 0, value: -0.5 }];
  const parameterPending = player.sendParameters(parameters); parameters[0].value = 1;
  const curvePending = player.scheduleCurve('HapticSharpnessControl', points); points[0].value = 1;
  await Promise.all([parameterPending, curvePending]);
  expect(commands.map(value => JSON.parse(value))).toEqual([
    { type: 'parameters', parameters: [{ id: 'HapticIntensityControl', value: 0.5 }] },
    { type: 'curve', id: 'HapticSharpnessControl', points: [{ time: 0, value: -0.5 }] },
  ]);
});

test('native lifecycle status and invalidated handles remain authoritative', async () => {
  let generation = 1; let reset = false;
  const client = createCoreHapticsClient(native({ async coreHapticsStatus() {
    return JSON.stringify({ ...status(), engine: reset ? 'reset' : 'running', generation,
      supportsHaptics: false, players: reset ? [] : status().players, lastError: reset ? 'Interrupted' : null,
      stoppedReason: reset ? 'audioSessionInterrupt' : null, private: 'not exported' });
  }, async coreHapticsReset() { generation++; reset = true; }, async coreHapticsCommand() {
    if (reset) throw new Error('Player was invalidated; create a new player.');
  } }));
  const player = await client.createPlayer(pattern()); await player.start();
  expect(await client.status()).toEqual({ ...status(), supportsHaptics: false });
  await client.reset();
  expect(await client.status()).toEqual({ ...status(), engine: 'reset', generation: 2, supportsHaptics: false,
    players: [], lastError: 'Interrupted', stoppedReason: 'audioSessionInterrupt' });
  await expect(player.resume()).rejects.toThrow('invalidated');
});

test('status retains command/callback provenance without calling it measured hardware playback', async () => {
  const nativeStatus = { ...status(), stateBasis: 'commandsAndCallbacks', players: [
    { ...status().players[0], state: 'finished', lastCommand: 'start', stateSource: 'completion', internal: 'omitted' },
  ] };
  const client = createCoreHapticsClient(native({ async coreHapticsStatus() { return JSON.stringify(nativeStatus); } }));
  expect(await client.status()).toEqual({ ...status(), stateBasis: 'commandsAndCallbacks', players: [
    { ...status().players[0], state: 'finished', lastCommand: 'start', stateSource: 'completion' },
  ] });
  nativeStatus.stateBasis = 'hardwareMeasurement';
  await expect(client.status()).rejects.toThrow('Invalid native Core Haptics status');
});

test('native Apple parser and hardware failures propagate without fake players or feedback success', async () => {
  const client = createCoreHapticsClient(native({ async coreHapticsCreate() { throw new Error('Unsupported AHAP audio event.'); },
    async coreHapticsStart() { throw new Error('Haptic hardware is unavailable.'); } }));
  await expect(client.createPlayer({ Version: 1, Pattern: [] })).rejects.toThrow('Unsupported AHAP audio event');
  await expect(client.start()).rejects.toThrow('Haptic hardware is unavailable');
  for (const response of ['bad JSON', '{}', JSON.stringify({ id: 'fake', duration: 1 }), JSON.stringify({ id, duration: -1 })]) {
    await expect(createCoreHapticsClient(native({ async coreHapticsCreate() { return response; } })).createPlayer(pattern())).rejects.toThrow();
  }
  for (const response of ['bad JSON', '{}', JSON.stringify({ ...status(), generation: 0.1 }),
    JSON.stringify({ ...status(), players: [{ ...status().players[0], state: 'invented' }] })]) {
    await expect(createCoreHapticsClient(native({ async coreHapticsStatus() { return response; } })).status()).rejects.toThrow();
  }
});
