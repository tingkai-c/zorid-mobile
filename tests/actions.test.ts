import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { createActionClient } from '../src/actions/client';
import { decodeActionTarget, encodeActionTarget, serializeActionBundle, serializeActionRequest } from '../src/actions/codec';
import type { ActionBundle, ActionRequest, NativeActions } from '../src/actions/types';

const request: ActionRequest = { appId: 'productivity', actionId: 'focus.pause', invocationId: 'session-1-pause-1',
  args: { taskTitle: '專注 🦔', nested: ['quotes " \\ /', 3, null] }, bundleVersion: 'focus-v1' };
const bundle: ActionBundle = { appId: 'productivity', version: 'focus-v1', runtimeVersion: 1,
  capabilities: ['records', 'surfaces'], handlers: { 'focus.pause': 'function(args, sdk) { return args; }' } };
function native(overrides: Partial<NativeActions> = {}): NativeActions {
  return {
    prepareDatabase: async () => '/shared/SQLite', installBundle: async () => {},
    dispatch: async json => JSON.stringify({ invocationId: JSON.parse(json).invocationId, duplicate: false, result: null, effects: [] }),
    pendingEffects: async () => '[]', acknowledgeEffects: async () => {},
    readOutbox: async () => '[]', acknowledgeOutbox: async () => {}, ...overrides,
  };
}

test('widget targets preserve UTF-8 and match the native base64url JSON transport', () => {
  const target = encodeActionTarget(request);
  expect(decodeActionTarget(target)).toEqual(request);
  const activityTarget = encodeActionTarget(request, { execution: 'activity' });
  expect(activityTarget.startsWith('zorid-activity-action:')).toBe(true);
  expect(decodeActionTarget(activityTarget)).toEqual(request);
  expect(target.slice('zorid-action:'.length)).toBe(Buffer.from(serializeActionRequest(request)).toString('base64url'));
  for (let length = 0; length < 20; length++) {
    const value = { ...request, args: 'a'.repeat(length) + 'é🌱' };
    expect(decodeActionTarget(encodeActionTarget(value))).toEqual(value);
  }
});

test('the bundled codec runs in bare JavaScriptCore-like globals', async () => {
  const harness = await Bun.build({ entrypoints: ['harness.ts'], target: 'browser', format: 'iife', plugins: [{
    name: 'codec-harness', setup(build) {
      build.onResolve({ filter: /^harness\.ts$/ }, () => ({ path: 'harness.ts', namespace: 'harness' }));
      build.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({ loader: 'ts', resolveDir: process.cwd(), contents:
        `import { encodeActionTarget, decodeActionTarget } from './src/actions/codec'; globalThis.roundTrip = value => decodeActionTarget(encodeActionTarget(value));` }));
    },
  }] });
  expect(harness.success).toBe(true);
  const context: { requestJSON: string; result: unknown; TextEncoder: undefined; TextDecoder: undefined; Buffer: undefined; btoa: undefined; atob: undefined } = { requestJSON: JSON.stringify(request), result: undefined, TextEncoder: undefined, TextDecoder: undefined, Buffer: undefined, btoa: undefined, atob: undefined };
  runInNewContext(await harness.outputs[0].text() + '\nresult = roundTrip(JSON.parse(requestJSON));', context);
  expect(context.result).toEqual(request);
});

test('malformed or oversized targets cannot reach native dispatch', () => {
  for (const target of ['other:abc', 'zorid-action:', 'zorid-action:a', 'zorid-action:abc=', 'zorid-action:ab',
    'zorid-action:' + Buffer.from([0xff, 0xfe]).toString('base64url'),
    'zorid-action:' + Buffer.from('{"appId":"../other"}').toString('base64url')]) {
    expect(() => decodeActionTarget(target)).toThrow();
  }
  expect(() => encodeActionTarget({ ...request, args: '🦔'.repeat(20_000) })).toThrow('byte limit');
  expect(() => serializeActionRequest({ ...request, args: '\ud800' })).toThrow('Unicode');
});

test('widget target limits are smaller than direct dispatch and apply to both execution modes', () => {
  const large = { ...request, args: 'a'.repeat(25 * 1024) };
  expect(serializeActionRequest(large)).toContain(large.args);
  expect(() => encodeActionTarget(large)).toThrow('Widget action target');
  expect(() => encodeActionTarget(large, { execution: 'activity' })).toThrow('Widget action target');
  const manuallyEncoded = Buffer.from(serializeActionRequest(large)).toString('base64url');
  expect(() => decodeActionTarget('zorid-action:' + manuallyEncoded)).toThrow('Malformed action target');
  expect(() => decodeActionTarget('zorid-activity-action:' + manuallyEncoded)).toThrow('Malformed action target');
});

test('serialization rejects lossy JSON, incompatible bundles and invalid capability declarations', () => {
  for (const args of [undefined, NaN, Infinity, new Date(), { fn: () => {} }, [undefined]]) {
    expect(() => serializeActionRequest({ ...request, args: args as never })).toThrow();
  }
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(() => serializeActionRequest({ ...request, args: cyclic as never })).toThrow('cycles');
  expect(() => serializeActionBundle({ ...bundle, runtimeVersion: 2 as never })).toThrow('runtime version');
  expect(() => serializeActionBundle({ ...bundle, capabilities: ['records', 'records'] })).toThrow('duplicate');
  expect(() => serializeActionBundle({ ...bundle, capabilities: ['camera' as never] })).toThrow('capability');
  expect(() => serializeActionBundle({ ...bundle, handlers: {} })).toThrow('1–64');
  expect(() => serializeActionBundle({ ...bundle, handlers: { action: ' '.repeat(128 * 1024 + 1) } })).toThrow();
  expect(JSON.parse(serializeActionRequest({ ...request, bundleVersion: undefined }))).not.toHaveProperty('bundleVersion');
});

test('failed bundle installation is retryable and concurrent installs only cache after success', async () => {
  let count = 0;
  const client = createActionClient(native({ installBundle: async () => { if (++count === 1) throw new Error('disk full'); } }));
  await expect(client.install(bundle)).rejects.toThrow('disk full');
  await Promise.all([client.install(bundle), client.install(bundle)]);
  expect(count).toBe(2);
  await client.install({ ...bundle, version: 'focus-v2' });
  expect(count).toBe(3);
});

test('committed changes survive surface failures and effects can be retried separately', async () => {
  let flushes = 0;
  const client = createActionClient(native(), { flushZoridActionEffects: async () => {
    if (++flushes === 1) throw new Error('Live Activity unavailable'); return 1;
  } });
  const result = await client.dispatch(request);
  expect(result).toMatchObject({ invocationId: request.invocationId, duplicate: false, result: null, surfaceError: 'Live Activity unavailable' });
  expect(await client.flushEffects(request.appId)).toBe(1);
  expect(flushes).toBe(2);
});

test('missing surface adapter does not acknowledge or pretend to apply pending effects', async () => {
  let acknowledged = false;
  const client = createActionClient(native({ pendingEffects: async () => '[{"id":"effect-1"}]', acknowledgeEffects: async () => { acknowledged = true; } }));
  expect((await client.dispatch(request)).surfaceError).toContain('pending');
  expect(acknowledged).toBe(false);
});

test('native failures do not block subsequent calls and detached invoke still generates IDs', async () => {
  const seen: ActionRequest[] = [];
  const client = createActionClient(native({ dispatch: async json => {
    const value = JSON.parse(json); seen.push(value);
    if (seen.length === 1) throw new Error('stale bundle');
    return JSON.stringify({ invocationId: value.invocationId, duplicate: false, result: 4, effects: [] });
  } }), null, () => 'generated-uuid');
  await expect(client.dispatch(request)).rejects.toThrow('stale bundle');
  const { invoke } = client;
  expect((await invoke('productivity', 'focus.pause', null)).result).toBe(4);
  expect(seen[1].invocationId).toBe('generated-uuid');
});

test('bridge request state is snapshotted before queueing and native response IDs are checked', async () => {
  const mutable = { ...request };
  const client = createActionClient(native());
  const result = client.dispatch(mutable); mutable.invocationId = 'changed-after-dispatch';
  expect((await result).invocationId).toBe(request.invocationId);
  const broken = createActionClient(native({ dispatch: async () => '{"invocationId":"wrong","duplicate":false,"result":null,"effects":[]}' }));
  await expect(broken.dispatch(request)).rejects.toThrow('Invalid native action response');
});

test('outbox stays scoped to its app and unavailable binaries fail explicitly', async () => {
  const client = createActionClient(native({ readOutbox: async () => '[{"id":"row-1","appId":"other","type":"sync","payload":{},"createdAt":1}]' }));
  await expect(client.readOutbox('productivity')).rejects.toThrow('Invalid native outbox');
  await expect(client.acknowledgeOutbox('productivity', ['../row'])).rejects.toThrow('Outbox ID');
  const unavailable = createActionClient(null);
  expect(unavailable.available).toBe(false);
  await expect(unavailable.dispatch(request)).rejects.toThrow('Install a Zorid binary');
});
