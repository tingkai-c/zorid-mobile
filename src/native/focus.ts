export type FocusInput = {
  taskTitle: string;
  status: 'running' | 'paused' | 'completed' | 'idle';
  /** Unix epoch milliseconds. */
  endsAt?: number;
  elapsedSeconds?: number;
};

export type FocusPresentation = {
  taskTitle: string;
  status: FocusInput['status'];
  statusLabel: string;
  startsAt: number;
  endsAt: number;
  elapsedLabel: string;
  elapsedSeconds: number;
};

export type SurfaceResult = {
  available: boolean;
  widgetUpdated: boolean;
  activityUpdated: boolean;
  error?: string;
};

export function presentFocus(input: FocusInput, now = Date.now()): FocusPresentation {
  const endsAt = Number.isFinite(input.endsAt) ? input.endsAt! : now;
  const status = input.status === 'running' && endsAt <= now ? 'completed' : input.status;
  const elapsed = Number.isFinite(input.elapsedSeconds)
    ? Math.max(0, Math.floor(input.elapsedSeconds!)) : 0;
  return {
    taskTitle: input.taskTitle.trim().slice(0, 160) || 'Choose a task',
    status,
    statusLabel: { running: 'Focusing', paused: 'Paused', completed: 'Session complete', idle: 'Ready to focus' }[status],
    startsAt: now,
    endsAt,
    elapsedSeconds: elapsed,
    elapsedLabel: `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`,
  };
}

export function focusTimeline(props: FocusPresentation, now: number) {
  const entries = [{ date: new Date(now), props }];
  if (props.status === 'running' && props.endsAt > now) {
    const elapsed = props.elapsedSeconds + Math.ceil((props.endsAt - now) / 1000);
    entries.push({ date: new Date(props.endsAt), props: {
      ...props, status: 'completed', statusLabel: 'Session complete', elapsedSeconds: elapsed,
      elapsedLabel: `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`,
    } });
  }
  return entries;
}
