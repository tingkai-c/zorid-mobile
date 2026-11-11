import { expect, test } from 'bun:test';
import { createScreenTimeClient, parseScreenTimeStatus, type NativeScreenTime, type ScreenTimeStatus } from '../src/screen-time/client';
import type { ScreenTimeCommand } from '../src/actions/types';
import { Database } from 'bun:sqlite';
import { initializeDocuments, saveDocument, type DocumentDatabase } from '../src/storage/documents';
import { readWorkspace } from '../src/features/workspace-storage';
import { disableFocusBlocking } from '../src/screen-time/disable';

function status(overrides: Partial<ScreenTimeStatus> = {}): ScreenTimeStatus {
  return { available: true, authorization: 'approved', policies: [{ id: 'focus', mode: 'blocklist', applicationCount: 2, categoryCount: 1 }], active: null, ...overrides };
}
function bridge(overrides: Partial<NativeScreenTime> = {}): NativeScreenTime {
  return {
    async status() { return JSON.stringify(status()); },
    async requestAuthorization() {},
    async editPolicy() { return JSON.stringify(status()); },
    async deletePolicy() {},
    async clear() {},
    async apply() {},
    ...overrides,
  };
}

test('unsupported binaries explicitly report no Screen Time capability and cannot pretend to block apps', async () => {
  const client = createScreenTimeClient(null);
  expect(client.available).toBe(false);
  expect(await client.status('productivity')).toMatchObject({ available: false, active: null, policies: [] });
  await expect(client.requestAuthorization('productivity')).rejects.toThrow('iPhone build');
  await expect(client.apply('productivity', { policyId: 'focus', sessionId: 'session-1', endsAt: 2_000 })).rejects.toThrow('iPhone build');
});

test('the JavaScript facade exposes metadata without forwarding opaque selection tokens', () => {
  const decoded = parseScreenTimeStatus(JSON.stringify({ ...status(), tokens: 'native-only',
    policies: [{ ...status().policies[0], applicationTokens: ['native-only'] }],
    active: { policyId: 'focus', sessionId: 'session-1', endsAt: 123_000, tokens: 'native-only' } }));
  expect(decoded).toEqual(status({ active: { policyId: 'focus', sessionId: 'session-1', endsAt: 123_000 } }));
  expect(JSON.stringify(decoded)).not.toContain('native-only');
});

test('malformed native policy or session responses fail instead of displaying a fabricated blocking state', () => {
  for (const value of [null, {}, { ...status(), active: undefined }, { ...status(), authorization: 'yes' },
    { ...status(), policies: [{ id: '../focus', mode: 'blocklist', applicationCount: 2, categoryCount: 0 }] },
    { ...status(), policies: [{ ...status().policies[0], applicationCount: -1 }] },
    { ...status(), active: { policyId: 'focus', sessionId: 'session-1', endsAt: 'later' } },
    { ...status(), policies: [status().policies[0], status().policies[0]] }]) {
    expect(() => parseScreenTimeStatus(JSON.stringify(value))).toThrow();
  }
});

test('authorization and picker cancellation return the actual native state', async () => {
  let requests = 0;
  const denied = status({ authorization: 'denied', policies: [] });
  const client = createScreenTimeClient(bridge({
    async requestAuthorization() { requests++; },
    async status() { return JSON.stringify(denied); },
    async editPolicy() { return JSON.stringify(denied); },
  }));
  expect(await client.requestAuthorization('productivity')).toEqual(denied);
  expect(requests).toBe(1);
  expect(await client.editPolicy('productivity', 'focus', 'allowlist')).toEqual(denied);
});

test('queued calls capture deployed commands before callers reuse their payload objects', async () => {
  const calls: { appId: string; command: unknown }[] = [];
  let release: () => void = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  const client = createScreenTimeClient(bridge({
    async requestAuthorization() { await wait; },
    async apply(appId, json) { calls.push({ appId, command: JSON.parse(json) }); },
  }));
  const permission = client.requestAuthorization('productivity');
  const command = { policyId: 'focus', sessionId: 'session-original', endsAt: 123_000 };
  const apply = client.apply('productivity', command);
  command.sessionId = 'session-changed'; command.endsAt = 456_000;
  release(); await permission; await apply;
  expect(calls).toEqual([{ appId: 'productivity', command: { policyId: 'focus', sessionId: 'session-original', endsAt: 123_000 } }]);
});

test('invalid deployment commands never reach native code and a failed request does not poison later clears', async () => {
  let calls = 0;
  const client = createScreenTimeClient(bridge({ async apply(_appId, json) {
    calls++;
    if (!JSON.parse(json).clear) throw new Error('Screen Time authorization was revoked.');
  } }));
  for (const command of [{ clear: false }, { clear: true, policyId: 'focus' },
    { policyId: 'focus', sessionId: 'session-1', endsAt: Infinity },
    { policyId: 'focus', sessionId: '../session', endsAt: 123_000 },
    { policyId: 'focus', sessionId: 'x'.repeat(65), endsAt: 123_000 },
    { policyId: 'focus', sessionId: 'session-1', endsAt: 123_000.5 },
    { policyId: 'focus', sessionId: 'session-1', endsAt: Date.now() + 25 * 60 * 60_000 },
    { policyId: 'focus', sessionId: 'session-1', endsAt: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(() => client.apply('productivity', command as ScreenTimeCommand)).toThrow();
  }
  expect(calls).toBe(0);
  await expect(client.apply('productivity', { policyId: 'focus', sessionId: 'session-1', endsAt: 123_000 })).rejects.toThrow('revoked');
  expect(await client.apply('productivity', { clear: true })).toEqual(status());
  expect(calls).toBe(2);
});

test('focus blocking preferences survive local database reloads and remain separate from app selection tokens', async () => {
  const connection = new Database(':memory:');
  const db: DocumentDatabase = {
    async execAsync(sql) { connection.exec(sql); },
    async runAsync(sql, ...parameters) { return connection.run(sql, parameters); },
    async getAllAsync<T>(sql: string, ...parameters: (string | number | null)[]) { return connection.query(sql).all(...parameters) as T[]; },
  };
  try {
    await initializeDocuments(db);
    expect((await readWorkspace(db)).focusPolicyId).toBeNull();
    const setting = { id: 'focus-screen-time', feature: 'productivity', collection: 'state', schemaVersion: 1, updatedAt: 1, data: { policyId: 'focus' } };
    await saveDocument(db, setting);
    expect((await readWorkspace(db)).focusPolicyId).toBe('focus');
    await saveDocument(db, { ...setting, updatedAt: 2, data: { policyId: null } });
    expect((await readWorkspace(db)).focusPolicyId).toBeNull();
    await saveDocument(db, { ...setting, data: { policyId: '../invalid' } });
    await expect(readWorkspace(db)).rejects.toThrow('Screen Time policy ID');
  } finally { connection.close(); }
});

test('normal disabling saves and clears without losing the person’s app selection', async () => {
  const calls: string[] = [];
  const result = await disableFocusBlocking({
    async saveDisabledPreference() { calls.push('save'); return true; },
    async clear() { calls.push('clear'); return status(); },
    async deletePolicy() { calls.push('delete'); return status({ policies: [] }); },
  });
  expect(calls).toEqual(['save', 'clear']);
  expect(result).toEqual({ status: status(), policyReset: false });
});

test('storage or action failures trigger immediate native release and invalidate the old selection', async () => {
  for (const failure of ['storage', 'action']) {
    const calls: string[] = [];
    const result = await disableFocusBlocking({
      async saveDisabledPreference() {
        calls.push('save');
        if (failure === 'storage') throw new Error('Local storage failed');
        return false;
      },
      async clear() { calls.push('clear'); return status(); },
      async deletePolicy() { calls.push('delete'); return status({ policies: [] }); },
    });
    expect(calls).toEqual(['save', 'clear', 'delete']);
    expect(result).toEqual({ status: status({ policies: [] }), policyReset: true });
  }
});

test('emergency recovery still invalidates pending activations when immediate clear rejects', async () => {
  const calls: string[] = [];
  await expect(disableFocusBlocking({
    async saveDisabledPreference() { return false; },
    async clear() { calls.push('clear'); throw new Error('Native clear failed'); },
    async deletePolicy() { calls.push('delete'); return status({ policies: [] }); },
  })).rejects.toThrow('could not be confirmed');
  expect(calls).toEqual(['clear', 'delete']);
});

test('a failed policy reset cannot be reported as a successful emergency release', async () => {
  await expect(disableFocusBlocking({
    async saveDisabledPreference() { return false; },
    async clear() { return status(); },
    async deletePolicy() { throw new Error('Native deletion failed'); },
  })).rejects.toThrow('could not be safely disabled');
});
