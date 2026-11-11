import { changeFocus, isFocusSession, isTask, startFocus, type FocusSession } from '../domain/focus';
import { presentFocus } from '../native/focus';
import { focusSessionPresentation } from '../native/focus-session';
import type { ActionSDK } from '../actions/types';
import { validateIdentifier } from '../actions/codec';

export type FocusControlArgs = { sessionId: string; revision: string; action: 'pause' | 'resume' | 'finish' };
export type FocusStartArgs = { action: 'start'; sessionId: string; taskId?: string | null };

export function focusRevision(session: FocusSession): string {
  return [session.status, session.runningSince ?? 0, session.endedAt ?? 0, session.intervals.length,
    session.intervals.at(-1)?.endedAt ?? 0].join(':');
}

export function focusActionHandler(args: FocusControlArgs | FocusStartArgs | { action: 'publish' }, sdk: ActionSDK) {
  if (!args || !['pause', 'resume', 'finish', 'publish', 'start'].includes(args.action)) {
    throw new Error('Invalid focus action');
  }
  if (args.action === 'publish') {
    const current = sdk.records.get<{ sessionId: string }>('state', 'focus-current');
    const session = current ? sdk.records.get('sessions', current.sessionId) : null;
    if (session !== null && !isFocusSession(session)) throw new Error('Focus session is unavailable');
    const props = session ? focusSessionPresentation(session as FocusSession, sdk.now)
      : presentFocus({ taskTitle: 'Ready to focus', status: 'idle' }, sdk.now);
    const inactive = props.status === 'completed' || props.status === 'idle';
    sdk.surfaces.publish({ widget: 'ZoridFocus', activity: 'ZoridFocusActivity',
      props: JSON.parse(JSON.stringify(props)),
      endActivity: inactive, startActivity: !inactive, url: 'zorid://apps/productivity/focus',
      ...(props.status === 'running' ? { staleAt: props.endsAt } : {}),
      timeline: JSON.parse(JSON.stringify(focusPublicationTimeline(props, sdk.now))),
    });
    publishScreenTime(sdk, session as FocusSession | null, props);
    return session;
  }
  if (args.action === 'start') {
    validateIdentifier(args.sessionId, 'Focus session ID');
    if (args.taskId !== undefined && args.taskId !== null) validateIdentifier(args.taskId, 'Task ID');
    // Bootstrap maintains this pointer; scanning all history would eventually
    // exceed the native action runtime's bounded list response.
    const current = sdk.records.get<{ sessionId: string }>('state', 'focus-current');
    if (current !== null) {
      if (!current || typeof current !== 'object') throw new Error('The current focus session pointer is invalid.');
      validateIdentifier(current.sessionId, 'Current focus session ID');
      const previous = sdk.records.get('sessions', current.sessionId);
      if (!isFocusSession(previous)) throw new Error('Focus session history is unavailable');
      if (previous.status !== 'completed') throw new Error('Finish your current focus session before starting another.');
    }
    if (sdk.records.get('sessions', args.sessionId) !== null) throw new Error('This focus session ID already exists.');
    const task = args.taskId ? sdk.records.get('tasks', args.taskId) : null;
    if (args.taskId && !isTask(task)) throw new Error('The selected task is unavailable.');
    const session = startFocus(args.sessionId, isTask(task) ? task : undefined, sdk.now);
    sdk.records.put('sessions', session.id, session);
    sdk.records.put('state', 'focus-current', { sessionId: session.id });
    const props = focusSessionPresentation(session, sdk.now);
    sdk.surfaces.publish({ widget: 'ZoridFocus', activity: 'ZoridFocusActivity',
      props: JSON.parse(JSON.stringify(props)), endActivity: false, startActivity: true,
      url: 'zorid://apps/productivity/focus', staleAt: props.endsAt,
      timeline: JSON.parse(JSON.stringify(focusPublicationTimeline(props, sdk.now))),
    });
    publishScreenTime(sdk, session, props);
    return session;
  }
  if (typeof args.sessionId !== 'string') throw new Error('Invalid focus action');
  const session = sdk.records.get('sessions', args.sessionId);
  if (!isFocusSession(session)) throw new Error('Focus session is unavailable');
  if (focusRevision(session) !== args.revision) throw new Error('This focus button is outdated. Refresh the session.');
  const changed = changeFocus(session, args.action, sdk.now);
  sdk.records.put('sessions', changed.id, changed);
  const props = focusSessionPresentation(changed, sdk.now);
  const completed = { ...props, status: 'completed', statusLabel: 'Session complete',
    elapsedSeconds: Math.floor(changed.targetMs / 1000),
    elapsedLabel: `${Math.floor(changed.targetMs / 60_000)}:${String(Math.floor(changed.targetMs / 1000) % 60).padStart(2, '0')}` };
  delete completed.pauseTarget; delete completed.resumeTarget; delete completed.finishTarget;
  sdk.surfaces.publish({
    widget: 'ZoridFocus', activity: 'ZoridFocusActivity', props: JSON.parse(JSON.stringify(props)),
    endActivity: changed.status === 'completed',
    ...(changed.status === 'running' ? { staleAt: props.endsAt } : {}),
    timeline: JSON.parse(JSON.stringify([{ date: sdk.now, props }, ...(changed.status === 'running' ? [{ date: props.endsAt, props: completed }] : [])])),
  });
  publishScreenTime(sdk, changed, props);
  return changed;
}

function publishScreenTime(sdk: ActionSDK, session: FocusSession | null,
  props: ReturnType<typeof presentFocus>) {
  // Older installed binaries and non-iOS previews have no Screen Time bridge.
  if (!sdk.screenTime) return;
  const setting = sdk.records.get<{ policyId: string | null }>('state', 'focus-screen-time');
  if (setting && setting.policyId !== null) validateIdentifier(setting.policyId, 'Screen Time policy ID');
  if (setting?.policyId && session && props.status === 'running' && props.endsAt > sdk.now) {
    sdk.screenTime.apply({ policyId: setting.policyId, sessionId: session.id, endsAt: props.endsAt });
  } else sdk.screenTime.apply({ clear: true });
}

function focusPublicationTimeline(props: ReturnType<typeof presentFocus>, now: number) {
  const entries = [{ date: now, props }];
  if (props.status === 'running' && props.endsAt > now) {
    const elapsed = props.elapsedSeconds + Math.ceil((props.endsAt - now) / 1000);
    const completed = { ...props, status: 'completed' as const, statusLabel: 'Session complete', elapsedSeconds: elapsed,
      elapsedLabel: `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` };
    delete completed.pauseTarget; delete completed.resumeTarget; delete completed.finishTarget;
    entries.push({ date: props.endsAt, props: completed });
  }
  return entries;
}
