import { describe, expect, test } from 'bun:test';
import { createDeviceClient, type NativeDevice } from './client';

const capabilities = {
  available: true, version: 1, platform: 'ios', requestBytes: 8_388_608, responseBytes: 8_388_608,
  features: { authentication: true, notifications: true, clipboard: true, photosPicker: true, photosAdd: true, calendar: true, reminders: true },
} as const;
function fixture(result = '{}') {
  const calls: [string, string, string][] = [];
  const native: NativeDevice = {
    capabilities: async () => JSON.stringify(capabilities),
    call: async (domain, operation, json) => { calls.push([domain, operation, json]); return result; },
  };
  return { native, calls, client: createDeviceClient(native) };
}

describe('deployed device client', () => {
  test('older binaries advertise unavailable and reject real operations', async () => {
    for (const native of [null, {} as NativeDevice]) {
      const client = createDeviceClient(native);
      expect(client.available).toBe(false);
      expect(await client.capabilities()).toMatchObject({ available: false, version: null, features: {} });
      await expect(client.authentication.status()).rejects.toThrow('zorid-5');
      await expect(client.notifications.schedule({ appId: 'focus', id: 'done', trigger: { type: 'delay', seconds: 60 } })).rejects.toThrow('Install');
    }
  });

  test('capabilities retain future feature flags but reject invalid versions and shapes', async () => {
    const { native, client } = fixture();
    native.capabilities = async () => JSON.stringify({ ...capabilities, features: { ...capabilities.features, futureFeature: false } });
    expect(await client.capabilities()).toEqual({ ...capabilities, features: { ...capabilities.features, futureFeature: false } });
    for (const value of [{ ...capabilities, version: 2 }, { ...capabilities, features: {} }, { ...capabilities, requestBytes: 10 }, []]) {
      native.capabilities = async () => JSON.stringify(value);
      await expect(client.capabilities()).rejects.toThrow();
    }
  });

  test('authentication and notifications preserve scoped wire contracts', async () => {
    const { client, calls } = fixture();
    await client.authentication.authenticate({ policy: 'deviceOwner', reason: 'Unlock journal', reuseDuration: 0 });
    await client.authentication.cancel();
    await client.notifications.request({ provisional: true });
    await client.notifications.categories({ appId: 'focus', categories: [{ id: 'timer', actions: [{ id: 'pause', title: 'Pause', options: ['foreground'] }] }] });
    await client.notifications.schedule({ appId: 'focus', id: 'finished', title: 'Finished', data: { session: '1' }, trigger: { type: 'date', at: 1_900_000_000_000 } });
    await client.notifications.cancel('focus');
    await client.notifications.removeDelivered('focus', ['finished']);
    await client.notifications.responses('focus');
    await client.notifications.acknowledge('focus', ['receipt']);
    expect(calls.map(([domain, operation, json]) => [domain, operation, JSON.parse(json)])).toEqual([
      ['authentication', 'authenticate', { policy: 'deviceOwner', reason: 'Unlock journal', reuseDuration: 0 }],
      ['authentication', 'cancel', {}],
      ['notifications', 'request', { provisional: true }],
      ['notifications', 'categories', { appId: 'focus', categories: [{ id: 'timer', actions: [{ id: 'pause', title: 'Pause', options: ['foreground'] }] }] }],
      ['notifications', 'schedule', { appId: 'focus', id: 'finished', title: 'Finished', data: { session: '1' }, trigger: { type: 'date', at: 1_900_000_000_000 } }],
      ['notifications', 'cancel', { appId: 'focus' }],
      ['notifications', 'removeDelivered', { appId: 'focus', ids: ['finished'] }],
      ['notifications', 'responses', { appId: 'focus' }],
      ['notifications', 'acknowledge', { appId: 'focus', ids: ['receipt'] }],
    ]);
  });

  test('media and EventKit map picker, write, query and native editor operations', async () => {
    const { client, calls } = fixture();
    await client.media.photosPick({ selectionLimit: 3, filter: 'images' });
    await client.media.photosSave({ uri: 'file:///private/app/photo.jpg', kind: 'image' });
    await client.media.clipboardSet({ text: 'hello', localOnly: true });
    await client.calendar.request({ entity: 'events', access: 'writeOnly' });
    await client.calendar.calendars('reminders');
    await client.calendar.saveEvent({ event: { title: 'Work', start: 1_900_000_000_000, end: 1_900_003_600_000, alarms: [-60, { absoluteAt: 1_899_999_000_000 }] }, span: 'thisEvent' });
    await client.calendar.editEvent();
    await client.calendar.reminders({ calendarIds: ['list'], completed: false, limit: 20 });
    await client.calendar.setReminderCompleted('todo', true);
    expect(calls.map(([domain, operation]) => [domain, operation])).toEqual([
      ['media', 'photosPick'], ['media', 'photosSave'], ['media', 'clipboardSet'],
      ['calendar', 'request'], ['calendar', 'calendars'], ['calendar', 'saveEvent'],
      ['calendar', 'editEvent'], ['calendar', 'reminders'], ['calendar', 'setReminderCompleted'],
    ]);
    expect(JSON.parse(calls[5][2]).event.alarms).toEqual([-60, { absoluteAt: 1_899_999_000_000 }]);
    expect(calls[6][2]).toBe('{}');
    expect(JSON.parse(calls[8][2])).toEqual({ id: 'todo', completed: true });
  });

  test('nested arguments are captured before an asynchronous bridge response', async () => {
    const { client, calls, native } = fixture();
    let resolve!: (value: string) => void;
    native.call = (domain, operation, json) => { calls.push([domain, operation, json]); return new Promise(done => { resolve = done; }); };
    const options = { appId: 'focus', id: 'done', data: { task: ['original'] }, trigger: { type: 'delay' as const, seconds: 10 } };
    const pending = client.notifications.schedule(options);
    options.data.task[0] = 'changed';
    options.trigger.seconds = 100;
    expect(JSON.parse(calls[0][2])).toMatchObject({ data: { task: ['original'] }, trigger: { seconds: 10 } });
    resolve('{"id":"done"}');
    expect(await pending).toEqual({ id: 'done' });
  });

  test('date-only reminders are writable and survive typed read/edit round trips', async () => {
    const dueAt = 1_900_000_000_000;
    const stored = {
      id: 'reminder', calendarId: 'list', title: 'Plan trip', notes: null, url: null,
      dueAt, startAt: dueAt, dueDateOnly: true, startDateOnly: true,
      priority: 0, completed: false, completedAt: null,
    };
    const { client, calls } = fixture(JSON.stringify(stored));
    const saved = await client.calendar.saveReminder({ title: 'Plan trip', dueAt, dueDateOnly: true, startAt: null });
    expect(JSON.parse(calls[0][2])).toEqual({ reminder: { title: 'Plan trip', dueAt, dueDateOnly: true, startAt: null } });
    expect(saved.dueDateOnly).toBe(true);
    expect(saved.startDateOnly).toBe(true);
    const loaded = await client.calendar.reminder('reminder');
    if (!loaded) throw new Error('Expected the native reminder result');
    const { completedAt, ...editable } = loaded;
    expect(completedAt).toBeNull();
    await client.calendar.saveReminder({ ...editable, title: 'Updated trip' });
    expect(JSON.parse(calls[2][2]).reminder).toMatchObject({
      title: 'Updated trip', dueAt, startAt: dueAt, dueDateOnly: true, startDateOnly: true,
    });
    expect(JSON.parse(calls[2][2]).reminder.completedAt).toBeUndefined();
  });

  test('lossy input never reaches native code or invokes accessor/toJSON hooks', async () => {
    const { client, calls } = fixture();
    let accessed = false;
    const getter = Object.defineProperty({}, 'text', { enumerable: true, get() { accessed = true; return 'hidden'; } });
    const customJSON = { toJSON() { accessed = true; return {}; } };
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const sparse = Array(2);
    const hidden = Object.defineProperty({}, 'text', { value: 'hidden' });
    const values = [getter, customJSON, cyclic, hidden, new Date(), { text: undefined }, { text: 1n },
      { text: Symbol('text') }, { [Symbol('hidden')]: true }, { data: sparse }, { text: NaN }, { text: Infinity },
      { text: -0 }, { text: Number.MAX_SAFE_INTEGER + 1 }];
    for (const value of values) await expect(client.media.clipboardSet(value as never)).rejects.toThrow();
    expect(accessed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('transport bounds count UTF-8 and JSON escaping rather than JS string length', async () => {
    const { client, calls } = fixture();
    await expect(client.media.clipboardSet({ text: '🙂'.repeat(2_097_152) })).rejects.toThrow('8 MiB');
    await expect(client.media.clipboardSet({ text: '\u0000'.repeat(1_398_102) })).rejects.toThrow('8 MiB');
    expect(calls).toHaveLength(0);
  });

  test('native errors retain their cause; malformed and oversized results reject', async () => {
    const { client, native } = fixture();
    const denied = new Error('Permission denied by iOS');
    native.call = async () => { throw denied; };
    await expect(client.calendar.status()).rejects.toBe(denied);
    for (const result of ['not JSON', '[]', 'true', 'null', '{"invalid":1e400}', `{"large":"${'x'.repeat(8_388_608)}"}`]) {
      native.call = async () => result;
      await expect(client.media.photosStatus()).rejects.toThrow();
    }
    native.call = async () => 'null';
    expect(await client.calendar.event('missing')).toBeNull();
    expect(await client.calendar.reminder('missing')).toBeNull();
  });
});
