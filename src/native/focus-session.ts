import { encodeActionTarget } from '../actions/codec';
import { workedMs, type FocusSession } from '../domain/focus';
import { presentFocus, type FocusPresentation } from './focus';

export const focusActionVersion = 'focus-actions-2';

// This module is bundled into both the app and the isolated action runtime.
export function focusSessionPresentation(session: FocusSession, now: number): FocusPresentation {
  const revision = [session.status, session.runningSince ?? 0, session.endedAt ?? 0, session.intervals.length,
    session.intervals.at(-1)?.endedAt ?? 0].join(':');
  const props = presentFocus({ taskTitle: session.taskTitle, status: session.status,
    elapsedSeconds: Math.floor(workedMs(session, now) / 1000),
    endsAt: session.runningSince === null ? undefined : session.runningSince + session.targetMs - workedMs({ ...session, runningSince: null }, now),
  }, now);
  if (props.status === 'running' || props.status === 'paused') {
    const target = (action: 'pause' | 'resume' | 'finish') => encodeActionTarget({
      appId: 'productivity', actionId: 'focus.control', bundleVersion: focusActionVersion,
      invocationId: `${session.id}-${revision}-${action}`.replace(/:/g, '-'),
      args: { sessionId: session.id, revision, action },
    }, { execution: 'activity' });
    if (props.status === 'running') props.pauseTarget = target('pause');
    else props.resumeTarget = target('resume');
    props.finishTarget = target('finish');
  }
  return props;
}
