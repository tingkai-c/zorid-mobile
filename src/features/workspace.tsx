import { randomUUID } from 'expo-crypto';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { changeFocus, FocusSession, isFocusSession, isTask, startFocus, Task, workedMs } from '../domain/focus';
import { getDatabase } from '../storage/database';
import { readDocuments, saveDocument } from '../storage/documents';
import { publishFocus } from '../native/surfaces';

type Snapshot = { tasks: Task[]; sessions: FocusSession[] };
type Workspace = Snapshot & {
  loading: boolean; error: string | null; surfaceError: string | null; busy: boolean; now: number;
  active: FocusSession | undefined; retry(): void; clearError(): void;
  addTask(title: string): Promise<boolean>; toggleTask(id: string): Promise<boolean>;
  start(taskId?: string): Promise<boolean>; control(action: 'pause' | 'resume' | 'finish'): Promise<boolean>;
};
const Context = createContext<Workspace | null>(null);
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ tasks: [], sessions: [] });
  const current = useRef(snapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const queue = useRef(Promise.resolve());
  const ready = useRef(false);
  const commit = useCallback((value: Snapshot) => { current.current = value; setSnapshot(value); }, []);
  useEffect(() => {
    let cancelled = false;
    ready.current = false;
    (async () => {
      const db = await getDatabase();
      const [tasks, sessions] = await Promise.all([readDocuments<Task>(db, 'productivity', 'tasks'), readDocuments<FocusSession>(db, 'productivity', 'sessions')]);
      if (!tasks.every(record => isTask(record.data)) || !sessions.every(record => isFocusSession(record.data))) throw new Error('A local record is invalid. Your data has been preserved.');
      if (sessions.filter(record => record.data.status !== 'completed').length > 1) throw new Error('Multiple active sessions found. Your data has been preserved.');
      if (!cancelled) { commit({ tasks: tasks.map(d => d.data), sessions: sessions.map(d => d.data) }); ready.current = true; }
    })().catch(e => { if (!cancelled) setError(String(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [attempt, commit]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') setNow(Date.now()); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, []);
  const mutate = useCallback((operation: (state: Snapshot) => Promise<Snapshot>) => {
    const next = queue.current.then(async () => {
      if (!ready.current) throw new Error('Local storage is not ready. Retry loading before making changes.');
      setBusy(true);
      try { commit(await operation(current.current)); setError(null); }
      finally { setBusy(false); }
    });
    queue.current = next.catch(e => { setError(e instanceof Error ? e.message : String(e)); });
    return next.then(() => true, () => false);
  }, [commit]);
  const persist = async (collection: string, data: Task | FocusSession) => {
    await saveDocument(await getDatabase(), { id: data.id, feature: 'productivity', collection, schemaVersion: 1, updatedAt: Date.now(), data });
  };
  const control = useCallback((action: 'pause' | 'resume' | 'finish') => mutate(async state => {
    const active = state.sessions.find(session => session.status !== 'completed');
    if (!active) return state;
    const changed = changeFocus(active, action, Date.now());
    await persist('sessions', changed);
    return { ...state, sessions: state.sessions.map(session => session.id === active.id ? changed : session) };
  }), [mutate]);
  const active = snapshot.sessions.find(session => session.status !== 'completed');
  useEffect(() => {
    if (active?.status === 'running' && workedMs(active, now) >= active.targetMs) void control('finish');
  }, [active, now, control]);
  useEffect(() => {
    if (!ready.current) return;
    const session = active ?? snapshot.sessions[0];
    void publishFocus(session ? {
      taskTitle: session.taskTitle, status: session.status,
      endsAt: session.runningSince === null ? undefined : session.runningSince + session.targetMs - workedMs({ ...session, runningSince: null }, Date.now()),
      elapsedSeconds: Math.floor(workedMs(session, Date.now()) / 1000),
    } : { taskTitle: 'Ready to focus', status: 'idle' }).then(result => setSurfaceError(result.error ?? null)).catch(() => setSurfaceError('Native surfaces could not update. Your session is saved locally.'));
  }, [active, snapshot.sessions, loading]);
  const value: Workspace = { ...snapshot, active, loading, error, surfaceError, busy, now,
    retry: () => { if (!busy) { ready.current = false; setLoading(true); setError(null); setAttempt(n => n + 1); } }, clearError: () => setError(null),
    addTask: title => mutate(async state => {
      const clean = title.trim(); if (!clean) return state;
      const task: Task = { id: randomUUID(), title: clean.slice(0, 300), completed: false, createdAt: Date.now() };
      await persist('tasks', task); return { ...state, tasks: [task, ...state.tasks] };
    }),
    toggleTask: id => mutate(async state => {
      const task = state.tasks.find(item => item.id === id); if (!task) return state;
      const changed = { ...task, completed: !task.completed }; await persist('tasks', changed);
      return { ...state, tasks: state.tasks.map(item => item.id === id ? changed : item) };
    }),
    start: taskId => mutate(async state => {
      if (state.sessions.some(session => session.status !== 'completed')) return state;
      const session = startFocus(randomUUID(), state.tasks.find(task => task.id === taskId), Date.now());
      await persist('sessions', session); return { ...state, sessions: [session, ...state.sessions] };
    }), control,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useWorkspace() { const context = useContext(Context); if (!context) throw new Error('WorkspaceProvider is missing'); return context; }
