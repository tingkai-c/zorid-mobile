import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { decodeActionTarget } from '../src/actions/codec';
import type { ActionSDK, JsonValue, SurfacePublication, ScreenTimeCommand } from '../src/actions/types';
import { changeFocus, startFocus, workedMs, type FocusSession } from '../src/domain/focus';
import { focusRevision, type FocusControlArgs } from '../src/features/focus-action-handler';
import { focusActionSource } from '../src/features/focus-actions.generated';

const connections: Database[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });

function harness(initial: FocusSession) {
  const db = new Database(':memory:'); connections.push(db);
  db.exec('CREATE TABLE records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(collection,id))');
  db.query('INSERT INTO records VALUES (?, ?, ?)').run('sessions', initial.id, JSON.stringify(initial));
  const publications: SurfacePublication[] = [];
  const restrictions: ScreenTimeCommand[] = [];
  let writes = 0;
  let lists = 0;
  function read(): FocusSession {
    const row = db.query<{data: string}, [string]>('SELECT data FROM records WHERE collection = \'sessions\' AND id = ?').get(initial.id);
    if (!row) throw new Error('Missing test session');
    return JSON.parse(row.data) as FocusSession;
  }
  function executeRequest(args: unknown, now: number): FocusSession | null {
    const sdk: ActionSDK = {
      now,
      records: {
        get<T>(collection: string, id: string): T | null {
          const row = db.query<{data: string}, [string, string]>('SELECT data FROM records WHERE collection = ? AND id = ?').get(collection, id);
          return row ? JSON.parse(row.data) as T : null;
        },
        list<T>(collection: string): T[] {
          lists++;
          return db.query<{data: string}, [string]>('SELECT data FROM records WHERE collection = ?').all(collection).map(row => JSON.parse(row.data) as T);
        },
        put(collection, id, data) {
          db.query('INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(collection,id) DO UPDATE SET data = excluded.data').run(collection, id, JSON.stringify(data));
          writes++;
        },
        delete() { throw new Error('Focus actions must retain session history'); },
      },
      outbox: { enqueue() { throw new Error('Focus example must not fabricate synchronization'); } },
      surfaces: { publish(effect) { publications.push(JSON.parse(JSON.stringify(effect)) as SurfacePublication); } },
      screenTime: { apply(command) { restrictions.push(JSON.parse(JSON.stringify(command)) as ScreenTimeCommand); } },
    };
    const context: { sdk: ActionSDK; argsJSON: string; result?: FocusSession | null } = {
      sdk, argsJSON: JSON.stringify(args),
    };
    // A fresh context for every invocation matches the native executor. Browser and
    // Node globals are deliberately absent, including TextEncoder/Buffer/require.
    const before = { writes, publications: publications.length, restrictions: restrictions.length };
    try {
      return db.transaction(() => {
        runInNewContext(`const handler = (${focusActionSource}); result = handler(JSON.parse(argsJSON), sdk);`, context);
        return JSON.parse(JSON.stringify(context.result)) as FocusSession | null;
      })();
    } catch (reason) {
      writes = before.writes;
      publications.length = before.publications;
      restrictions.length = before.restrictions;
      throw reason;
    }
  }
  function execute(action: FocusControlArgs['action'], now: number, revision = focusRevision(read())): FocusSession {
    const result = executeRequest({ sessionId: initial.id, revision, action }, now);
    if (!result) throw new Error('Expected an updated session');
    return result;
  }
  function seed(collection: string, id: string, data: unknown) {
    db.query('INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(collection,id) DO UPDATE SET data = excluded.data').run(collection, id, JSON.stringify(data));
  }
  return { read, execute, executeRequest, seed, publications, restrictions, get writes() { return writes; }, get lists() { return lists; } };
}

function session(targetMs = 25 * 60_000) {
  return startFocus('session-123', { id: 'task-123', title: '專注 🦔', completed: false, createdAt: 10 }, 1_000, targetMs);
}
function stringProp(effect: SurfacePublication, key: string): string {
  const value: JsonValue | undefined = effect.props[key];
  if (typeof value !== 'string') throw new Error(`Missing surface property ${key}`);
  return value;
}

test('the exported standalone handler pauses, resumes and finishes the same durable session', () => {
  const initial = session(); const runtime = harness(initial);
  const paused = runtime.execute('pause', 121_000);
  expect(paused).toEqual(changeFocus(initial, 'pause', 121_000));
  expect(runtime.read()).toEqual(paused);
  expect(paused.intervals).toEqual([{ startedAt: 1_000, endedAt: 121_000 }]);
  const resumed = runtime.execute('resume', 181_000);
  expect(resumed).toEqual(changeFocus(paused, 'resume', 181_000));
  const finished = runtime.execute('finish', 241_000);
  expect(finished).toEqual(changeFocus(resumed, 'finish', 241_000));
  expect(runtime.read()).toEqual(finished);
  expect(workedMs(finished, 999_000)).toBe(180_000);
  expect(finished.taskId).toBe('task-123');
  expect(finished.taskTitle).toBe('專注 🦔');
  expect(runtime.writes).toBe(3);
  expect(runtime.publications).toHaveLength(3);
  expect(runtime.publications[2].endActivity).toBe(true);
});

test('a stale rendered button is rejected before changing records or surface state', () => {
  const initial = session(); const runtime = harness(initial);
  const staleRevision = focusRevision(initial);
  const paused = runtime.execute('pause', 61_000);
  const before = runtime.writes;
  expect(() => runtime.execute('finish', 62_000, staleRevision)).toThrow('outdated');
  expect(runtime.writes).toBe(before);
  expect(runtime.read()).toEqual(paused);
  expect(runtime.publications).toHaveLength(1);
});

test('generated actions publish activity-intent targets that carry the new stored revision', () => {
  const initial = session(); const runtime = harness(initial);
  const paused = runtime.execute('pause', 61_000);
  const effect = runtime.publications[0];
  const target = stringProp(effect, 'resumeTarget');
  expect(target.startsWith('zorid-activity-action:')).toBe(true);
  const decoded = decodeActionTarget(target);
  expect(decoded).toMatchObject({ appId: 'productivity', actionId: 'focus.control', bundleVersion: 'focus-actions-2',
    args: { sessionId: initial.id, revision: focusRevision(paused), action: 'resume' } });
  expect(decoded.invocationId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  expect(effect.props.pauseTarget).toBeUndefined();
  expect(effect.widget).toBe('ZoridFocus');
  expect(effect.activity).toBe('ZoridFocusActivity');
  const resumed = runtime.execute('resume', 121_000);
  const next = runtime.publications[1];
  expect(decodeActionTarget(stringProp(next, 'pauseTarget')).args).toEqual({ sessionId: initial.id, revision: focusRevision(resumed), action: 'pause' });
  expect(decodeActionTarget(stringProp(next, 'finishTarget')).invocationId).not.toBe(decodeActionTarget(stringProp(effect, 'finishTarget')).invocationId);
});

test('unchanged session state retains stable button invocation IDs across fresh runtimes', () => {
  const initial = session(); const first = harness(initial); const second = harness(initial);
  first.execute('resume', 11_000); second.execute('resume', 21_000);
  expect(first.read()).toEqual(second.read());
  for (const key of ['pauseTarget', 'finishTarget']) {
    expect(stringProp(first.publications[0], key)).toBe(stringProp(second.publications[0], key));
  }
});

test('running timelines carry an exact completion boundary with no leftover action buttons', () => {
  const initial = session(); const runtime = harness(initial);
  runtime.execute('resume', 61_000);
  const effect = runtime.publications[0];
  expect(effect.timeline).toHaveLength(2);
  expect(effect.staleAt).toBe(1_501_000);
  expect(effect.timeline![1].date).toBe(1_501_000);
  expect(effect.timeline![1].props).toMatchObject({ status: 'completed', statusLabel: 'Session complete', elapsedSeconds: 1500, elapsedLabel: '25:00' });
  for (const key of ['pauseTarget', 'resumeTarget', 'finishTarget']) expect(effect.timeline![1].props).not.toHaveProperty(key);
  expect(effect.endActivity).toBe(false);
});

test('late native actions cap persisted work at the focus target and finish the activity', () => {
  const initial = session(60_000); const runtime = harness(initial);
  const completed = runtime.execute('pause', 91_000);
  expect(completed.status).toBe('completed');
  expect(completed.intervals).toEqual([{ startedAt: 1_000, endedAt: 61_000 }]);
  expect(completed.endedAt).toBe(61_000);
  expect(workedMs(runtime.read(), 999_000)).toBe(60_000);
  const effect = runtime.publications[0];
  expect(effect.endActivity).toBe(true);
  expect(effect.timeline).toHaveLength(1);
  for (const key of ['pauseTarget', 'resumeTarget', 'finishTarget']) expect(effect.props).not.toHaveProperty(key);
});


test('focus publication follows the shared durable current pointer without writing records', () => {
  const obsolete = session(); const runtime = harness(obsolete);
  const latest = startFocus('session-latest', { id: 'task-latest', title: 'Latest durable task', completed: false, createdAt: 2_000 }, 5_000);
  runtime.seed('sessions', latest.id, latest);
  runtime.seed('state', 'focus-current', { sessionId: latest.id });
  const result = runtime.executeRequest({ action: 'publish' }, 65_000);
  expect(result).toEqual(latest);
  expect(runtime.read()).toEqual(obsolete);
  expect(runtime.writes).toBe(0);
  const effect = runtime.publications[0];
  expect(effect.props.taskTitle).toBe(latest.taskTitle);
  expect(effect.props.status).toBe('running');
  expect(effect.startActivity).toBe(true);
  expect(effect.endActivity).toBe(false);
  expect(effect.url).toBe('zorid://apps/productivity/focus');
  expect(decodeActionTarget(stringProp(effect, 'pauseTarget')).args).toMatchObject({ sessionId: latest.id, revision: focusRevision(latest) });
  expect(effect.timeline).toHaveLength(2);
  for (const key of ['pauseTarget', 'resumeTarget', 'finishTarget']) expect(effect.timeline![1].props).not.toHaveProperty(key);
});

test('publication with no shared current pointer stays idle and ends any old activity', () => {
  const obsolete = session(); const runtime = harness(obsolete);
  expect(runtime.executeRequest({ action: 'publish' }, 65_000)).toBeNull();
  expect(runtime.read()).toEqual(obsolete);
  expect(runtime.writes).toBe(0);
  expect(runtime.publications).toHaveLength(1);
  const effect = runtime.publications[0];
  expect(effect.props.status).toBe('idle');
  expect(effect.endActivity).toBe(true);
  expect(effect.startActivity).toBe(false);
  expect(effect.timeline).toHaveLength(1);
  for (const key of ['pauseTarget', 'resumeTarget', 'finishTarget']) expect(effect.props).not.toHaveProperty(key);
});

test('publication of a completed durable session clears all buttons without a refresh write loop', () => {
  const initial = session(); const runtime = harness(initial);
  const completed = changeFocus(initial, 'finish', 61_000);
  runtime.seed('sessions', completed.id, completed);
  runtime.seed('state', 'focus-current', { sessionId: completed.id });
  expect(runtime.executeRequest({ action: 'publish' }, 121_000)).toEqual(completed);
  expect(runtime.read()).toEqual(completed);
  expect(runtime.writes).toBe(0);
  const effect = runtime.publications[0];
  expect(effect.props.status).toBe('completed');
  expect(effect.endActivity).toBe(true);
  expect(effect.startActivity).toBe(false);
  expect(effect.timeline).toHaveLength(1);
  for (const key of ['pauseTarget', 'resumeTarget', 'finishTarget']) {
    expect(effect.props).not.toHaveProperty(key);
    expect(effect.timeline![0].props).not.toHaveProperty(key);
  }
});

test('deployed focus actions apply the chosen policy and clear restrictions through native pause and finish', () => {
  const initial = session(); const runtime = harness(initial);
  runtime.seed('state', 'focus-current', { sessionId: initial.id });
  runtime.seed('state', 'focus-screen-time', { policyId: 'focus' });
  runtime.executeRequest({ action: 'publish' }, 61_000);
  expect(runtime.restrictions).toEqual([{ policyId: 'focus', sessionId: initial.id, endsAt: 1_501_000 }]);
  runtime.execute('pause', 121_000);
  expect(runtime.restrictions.at(-1)).toEqual({ clear: true });
  runtime.execute('resume', 181_000);
  expect(runtime.restrictions.at(-1)).toEqual({ policyId: 'focus', sessionId: initial.id, endsAt: 1_561_000 });
  runtime.execute('finish', 241_000);
  expect(runtime.restrictions.at(-1)).toEqual({ clear: true });
});

test('disabling the durable policy supersedes restrictions while the timer continues', () => {
  const initial = session(); const runtime = harness(initial);
  runtime.seed('state', 'focus-current', { sessionId: initial.id });
  runtime.seed('state', 'focus-screen-time', { policyId: 'focus' });
  runtime.executeRequest({ action: 'publish' }, 61_000);
  runtime.seed('state', 'focus-screen-time', { policyId: null });
  runtime.executeRequest({ action: 'publish' }, 62_000);
  expect(runtime.restrictions.at(-1)).toEqual({ clear: true });
  expect(runtime.read()).toEqual(initial);
  expect(runtime.writes).toBe(0);
});

test('idle and expired timers release restrictions instead of scheduling an expired deadline', () => {
  const initial = session(60_000); const runtime = harness(initial);
  runtime.seed('state', 'focus-screen-time', { policyId: 'focus' });
  runtime.executeRequest({ action: 'publish' }, 65_000);
  expect(runtime.restrictions.at(-1)).toEqual({ clear: true });
  runtime.seed('state', 'focus-current', { sessionId: initial.id });
  runtime.executeRequest({ action: 'publish' }, 65_000);
  expect(runtime.restrictions.at(-1)).toEqual({ clear: true });
});

test('a downloaded start action commits the session, current pointer and blocking command without a React effect', () => {
  const completed = changeFocus(session(), 'finish', 61_000); const runtime = harness(completed);
  runtime.seed('tasks', 'task-new', { id: 'task-new', title: 'Write a chapter', createdAt: 10, completed: false });
  runtime.seed('state', 'focus-screen-time', { policyId: 'focus' });
  const started = runtime.executeRequest({ action: 'start', sessionId: 'session-new', taskId: 'task-new' }, 65_000);
  expect(started).toEqual(startFocus('session-new', { id: 'task-new', title: 'Write a chapter', createdAt: 10, completed: false }, 65_000));
  expect(runtime.writes).toBe(2);
  expect(runtime.publications).toHaveLength(1);
  expect(runtime.publications[0]).toMatchObject({ startActivity: true, endActivity: false, staleAt: 1_565_000 });
  expect(runtime.restrictions).toEqual([{ policyId: 'focus', sessionId: 'session-new', endsAt: 1_565_000 }]);
  expect(runtime.executeRequest({ action: 'publish' }, 66_000)).toEqual(started);
  expect(runtime.read()).toEqual(completed);
  expect(runtime.writes).toBe(2);
});

test('invalid native start requests cannot overwrite history or create a second active session', () => {
  const active = harness(session());
  active.seed('state', 'focus-current', { sessionId: session().id });
  expect(() => active.executeRequest({ action: 'start', sessionId: 'session-new' }, 65_000)).toThrow('current focus');
  expect(active.writes).toBe(0);
  expect(active.publications).toHaveLength(0);
  const completed = changeFocus(session(), 'finish', 61_000); const runtime = harness(completed);
  for (const request of [{ action: 'start', sessionId: completed.id }, { action: 'start', sessionId: '../invalid' },
    { action: 'start', sessionId: 'session-new', taskId: 'missing-task' }]) {
    expect(() => runtime.executeRequest(request, 65_000)).toThrow();
  }
  expect(runtime.read()).toEqual(completed);
  expect(runtime.writes).toBe(0);
  expect(runtime.publications).toHaveLength(0);
  expect(runtime.restrictions).toHaveLength(0);
});

test('starting focus reads the current pointer without listing more than a thousand historic sessions', () => {
  const completed = changeFocus(session(), 'finish', 61_000); const runtime = harness(completed);
  for (let index = 0; index < 1100; index++) {
    runtime.seed('sessions', `historic-${index}`, { ...completed, id: `historic-${index}` });
  }
  runtime.seed('state', 'focus-current', { sessionId: completed.id });
  const started = runtime.executeRequest({ action: 'start', sessionId: 'session-new' }, 65_000);
  expect(started?.status).toBe('running');
  expect(runtime.lists).toBe(0);
  expect(runtime.writes).toBe(2);
  expect(runtime.executeRequest({ action: 'publish' }, 66_000)).toEqual(started);
});

test('a malformed current pointer or invalid referenced session prevents native start without changing history', () => {
  const completed = changeFocus(session(), 'finish', 61_000); const runtime = harness(completed);
  for (const pointer of ['invalid', {}, { sessionId: '../invalid' }, { sessionId: 'missing-session' }]) {
    runtime.seed('state', 'focus-current', pointer);
    expect(() => runtime.executeRequest({ action: 'start', sessionId: 'session-new' }, 65_000)).toThrow();
  }
  runtime.seed('sessions', 'invalid-session', { id: 'invalid-session', status: 'completed' });
  runtime.seed('state', 'focus-current', { sessionId: 'invalid-session' });
  expect(() => runtime.executeRequest({ action: 'start', sessionId: 'session-new' }, 65_000)).toThrow('history is unavailable');
  expect(runtime.read()).toEqual(completed);
  expect(runtime.writes).toBe(0);
  expect(runtime.publications).toHaveLength(0);
  expect(runtime.restrictions).toHaveLength(0);
});

test('a rejected blocking policy rolls back start records, pointer and queued native effects together', () => {
  const completed = changeFocus(session(), 'finish', 61_000); const runtime = harness(completed);
  runtime.seed('state', 'focus-screen-time', { policyId: '../invalid' });
  expect(() => runtime.executeRequest({ action: 'start', sessionId: 'session-new' }, 65_000)).toThrow('Screen Time policy ID');
  expect(runtime.writes).toBe(0);
  expect(runtime.publications).toHaveLength(0);
  expect(runtime.restrictions).toHaveLength(0);
  runtime.seed('state', 'focus-screen-time', { policyId: null });
  expect(runtime.executeRequest({ action: 'publish' }, 66_000)).toBeNull();
  expect(runtime.executeRequest({ action: 'start', sessionId: 'session-new' }, 67_000)?.status).toBe('running');
});
