export type Task = { id: string; title: string; completed: boolean; createdAt: number };
export type WorkInterval = { startedAt: number; endedAt: number };
export type FocusSession = {
  id: string; taskId: string | null; taskTitle: string; startedAt: number;
  targetMs: number; intervals: WorkInterval[]; runningSince: number | null;
  status: 'running' | 'paused' | 'completed'; endedAt: number | null;
};
export function workedMs(session: FocusSession, now: number): number {
  return Math.min(session.targetMs, session.intervals.reduce((sum, item) => sum + Math.max(0, item.endedAt - item.startedAt), 0)
    + (session.runningSince === null ? 0 : Math.max(0, now - session.runningSince)));
}
export function startFocus(id: string, task: Task | undefined, now: number, targetMs = 25 * 60_000): FocusSession {
  if (!Number.isFinite(targetMs) || targetMs <= 0) throw new Error('Focus duration must be positive');
  return { id, taskId: task?.id ?? null, taskTitle: task?.title ?? 'Open focus', startedAt: now, targetMs, intervals: [], runningSince: now, status: 'running', endedAt: null };
}
export function changeFocus(session: FocusSession, action: 'pause' | 'resume' | 'finish', now: number): FocusSession {
  if (session.status === 'completed') return session;
  const elapsed = workedMs(session, now);
  const completed = elapsed >= session.targetMs || action === 'finish';
  if (!completed && action === 'resume') return session.status === 'running' ? session : { ...session, status: 'running', runningSince: now };
  const remaining = session.targetMs - workedMs({ ...session, runningSince: null }, now);
  const end = session.runningSince === null ? now : Math.max(session.runningSince, Math.min(now, session.runningSince + remaining));
  const intervals = session.runningSince !== null && end > session.runningSince
    ? [...session.intervals, { startedAt: session.runningSince, endedAt: end }] : session.intervals;
  return { ...session, intervals, runningSince: null, status: completed ? 'completed' : 'paused', endedAt: completed ? end : null };
}
export function isTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object') return false;
  const item = value as Task;
  return typeof item.id === 'string' && typeof item.title === 'string' && typeof item.completed === 'boolean' && Number.isFinite(item.createdAt);
}
export function isFocusSession(value: unknown): value is FocusSession {
  if (!value || typeof value !== 'object') return false;
  const item = value as FocusSession;
  return typeof item.id === 'string' && (item.taskId === null || typeof item.taskId === 'string') && typeof item.taskTitle === 'string'
    && Number.isFinite(item.startedAt) && Number.isFinite(item.targetMs) && item.targetMs > 0
    && ['running', 'paused', 'completed'].includes(item.status)
    && (item.runningSince === null || Number.isFinite(item.runningSince))
    && (item.endedAt === null || Number.isFinite(item.endedAt))
    && (item.status === 'running' ? item.runningSince !== null : item.runningSince === null)
    && Array.isArray(item.intervals) && item.intervals.every(interval => interval && Number.isFinite(interval.startedAt) && Number.isFinite(interval.endedAt) && interval.endedAt >= interval.startedAt);
}
