import { expect, test } from 'bun:test';
import { createHapticsClient, type NativeHaptics, type HapticImpactOptions,
  type HapticImpactStyle, type HapticOptions, type HapticNotificationType } from './haptics-client';

function native(overrides: Partial<NativeHaptics> = {}): NativeHaptics {
  return { async hapticsStatus() { return JSON.stringify({ available: true, location: true, supportsHaptics: true }); },
    async impact() {}, async selection() {}, async notification() {}, async prepareHaptics() {}, async resetHaptics() {}, ...overrides };
}

test('old or absent binaries report unavailable without pretending to produce feedback', async () => {
  for (const module of [null, {}, { async hapticsStatus() { return '{}'; } }]) {
    const client = createHapticsClient(module);
    expect(client.available).toBe(false);
    expect(await client.status()).toEqual({ available: false, location: false, supportsHaptics: null,
      reason: 'Install a Zorid iPhone build with the haptics bridge to use native feedback.' });
    await expect(client.impact('light')).rejects.toThrow('iPhone build with the haptics bridge');
    await expect(client.selection()).rejects.toThrow('iPhone build with the haptics bridge');
    await expect(client.notification('success')).rejects.toThrow('iPhone build with the haptics bridge');
    await expect(client.prepare('impact')).rejects.toThrow('iPhone build with the haptics bridge');
    await expect(client.reset()).rejects.toThrow('iPhone build with the haptics bridge');
  }
});

test('styles, native default intensity, explicit endpoints and view-relative points cross the bridge unchanged', async () => {
  const calls: unknown[][] = [];
  const client = createHapticsClient(native({ async impact(...args) { calls.push(['impact', ...args]); },
    async selection(...args) { calls.push(['selection', ...args]); },
    async notification(...args) { calls.push(['notification', ...args]); } }));
  for (const style of ['light', 'medium', 'heavy', 'soft', 'rigid'] as const) await client.impact(style);
  await client.impact('heavy', { intensity: 0 });
  await client.impact('soft', { intensity: 1, at: { x: -12.5, y: 8000.25 } });
  await client.selection({ at: { x: 0, y: 12.5 } });
  await client.selection();
  for (const type of ['success', 'warning', 'error'] as const) await client.notification(type);
  await client.notification('warning', { at: { x: -1, y: -2 } });
  expect(calls).toEqual([
    ['impact', 'light', null, null], ['impact', 'medium', null, null], ['impact', 'heavy', null, null],
    ['impact', 'soft', null, null], ['impact', 'rigid', null, null], ['impact', 'heavy', 0, null],
    ['impact', 'soft', 1, '{"x":-12.5,"y":8000.25}'], ['selection', '{"x":0,"y":12.5}'], ['selection', null],
    ['notification', 'success', null], ['notification', 'warning', null], ['notification', 'error', null],
    ['notification', 'warning', '{"x":-1,"y":-2}'],
  ]);
});

test('invalid or unknown options never reach native', async () => {
  let calls = 0;
  const client = createHapticsClient(native({ async impact() { calls++; }, async selection() { calls++; }, async notification() { calls++; } }));
  for (const style of ['', 'loud', null, 1]) await expect(client.impact(style as HapticImpactStyle)).rejects.toThrow();
  for (const type of ['', 'info', null, 1]) await expect(client.notification(type as HapticNotificationType)).rejects.toThrow();
  for (const intensity of [-0.1, 1.1, NaN, Infinity, -Infinity, null, '1']) {
    await expect(client.impact('light', { intensity } as HapticImpactOptions)).rejects.toThrow();
  }
  const options: unknown[] = [null, [], new Date(), { duration: 1 }, { at: null }, { at: [] },
    { at: {} }, { at: { x: 1 } }, { at: { x: '1', y: 2 } }, { at: { x: 1, y: NaN } },
    { at: { x: Infinity, y: 0 } }, { at: { x: 1, y: 2, z: 3 } }, { [Symbol('unknown')]: 1 },
    Object.defineProperty({}, 'unknown', { value: 1 })];
  for (const option of options) {
    await expect(client.impact('medium', option as HapticImpactOptions)).rejects.toThrow();
    await expect(client.selection(option as HapticOptions)).rejects.toThrow();
    await expect(client.notification('error', option as HapticOptions)).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test('points and intensity are captured before asynchronous native completion', async () => {
  let finish!: () => void;
  let captured: unknown[] = [];
  const client = createHapticsClient(native({ async impact(...args) {
    captured = args;
    await new Promise<void>(resolve => { finish = resolve; });
  } }));
  const options = { intensity: 0.35, at: { x: 12, y: -25 } };
  const pending = client.impact('rigid', options);
  options.intensity = 0.9; options.at.x = 100; options.at.y = 200;
  expect(captured).toEqual(['rigid', 0.35, '{"x":12,"y":-25}']);
  finish(); await pending;
});

test('hardware status remains advisory and native location errors propagate', async () => {
  let calls = 0;
  const client = createHapticsClient(native({ async hapticsStatus() {
    return JSON.stringify({ available: true, location: false, supportsHaptics: false, ignored: true });
  }, async impact(_style, _intensity, pointJSON) {
    calls++; if (pointJSON !== null) throw new Error('Location-based haptics require iOS 17.5 or later.');
  } }));
  expect(client.available).toBe(true);
  expect(await client.status()).toEqual({ available: true, location: false, supportsHaptics: false });
  await client.impact('light');
  await expect(client.impact('light', { at: { x: 1, y: 2 } })).rejects.toThrow('iOS 17.5');
  expect(calls).toBe(2);
});

test('preparation and reset preserve generator choices and independently detect older bridges', async () => {
  const calls: unknown[][] = [];
  const client = createHapticsClient(native({ async prepareHaptics(...args) { calls.push(['prepare', ...args]); },
    async resetHaptics() { calls.push(['reset']); } }));
  await client.prepare('impact'); await client.prepare('impact', 'heavy');
  await client.prepare('selection'); await client.prepare('notification'); await client.reset();
  expect(calls).toEqual([['prepare', 'impact', null], ['prepare', 'impact', 'heavy'],
    ['prepare', 'selection', null], ['prepare', 'notification', null], ['reset']]);
  // These calls deliberately bypass TypeScript to exercise the deployed-JS boundary.
  const prepare = client.prepare as (kind: unknown, style?: unknown) => Promise<void>;
  await expect(prepare('selection', 'heavy')).rejects.toThrow('Only an impact');
  await expect(prepare('notification', 'light')).rejects.toThrow('Only an impact');
  await expect(prepare('impact', 'unknown')).rejects.toThrow();
  await expect(prepare('unknown')).rejects.toThrow();
  expect(calls).toHaveLength(5);
  const older = createHapticsClient(native({ prepareHaptics: undefined, resetHaptics: undefined }));
  expect(older.available).toBe(true);
  await expect(older.prepare('impact')).rejects.toThrow('preparation support');
  await expect(older.reset()).rejects.toThrow('reset support');
});

test('malformed native status is rejected instead of guessing hardware or OS support', async () => {
  for (const json of ['not JSON', 'null', '[]', '{}', '{"available":true,"location":true,"supportsHaptics":null}',
    '{"available":true,"location":"yes","supportsHaptics":true}']) {
    await expect(createHapticsClient(native({ async hapticsStatus() { return json; } })).status()).rejects.toThrow('Invalid native haptics status.');
  }
});
