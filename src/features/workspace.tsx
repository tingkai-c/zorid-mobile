import { randomUUID } from 'expo-crypto';
import { requireOptionalNativeModule } from 'expo';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { actions } from '../actions';
import { validateIdentifier } from '../actions/codec';
import { screenTime } from '../screen-time';
import { changeFocus, type FocusSession, startFocus, type Task, workedMs } from '../domain/focus';
import { getDatabase } from '../storage/database';
import { saveDocument, type DocumentDatabase } from '../storage/documents';
import { publishFocus, registerFocusLayouts } from '../native/surfaces';
import { focusSessionPresentation, focusActionVersion } from '../native/focus-session';
import { focusRevision } from './focus-action-handler';
import { focusActionSource } from './focus-actions.generated';
import { readWorkspace, type WorkspaceSnapshot as Snapshot } from './workspace-storage';

type Workspace = Snapshot & {
  loading: boolean; error: string | null; surfaceError: string | null; busy: boolean; now: number;
  active: FocusSession | undefined; retry(): void; clearError(): void;
  addTask(title: string): Promise<boolean>; toggleTask(id: string): Promise<boolean>;
  start(taskId?: string): Promise<boolean>; control(action: 'pause' | 'resume' | 'finish'): Promise<boolean>;
  setFocusPolicy(policyId: string | null): Promise<boolean>;
};
const Context = createContext<Workspace | null>(null);
async function installActions() {
  if (!actions.available) return;
  await registerFocusLayouts();
  await actions.install({ appId: 'productivity', version: focusActionVersion, runtimeVersion: 1,
    capabilities: ['records', 'surfaces', ...(screenTime.available ? ['screenTime' as const] : [])],
    handlers: { 'focus.control': focusActionSource, 'focus.publish': focusActionSource, 'focus.start': focusActionSource } });
}
async function persist(db: DocumentDatabase, collection: string, data: Task | FocusSession) {
  await saveDocument(db, { id: data.id, feature: 'productivity', collection, schemaVersion: 1, updatedAt: Date.now(), data });
  if (collection === 'sessions') await saveDocument(db, { id: 'focus-current', feature: 'productivity', collection: 'state',
    schemaVersion: 1, updatedAt: Date.now(), data: { sessionId: data.id } });
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ tasks: [], sessions: [], focusPolicyId: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const queue = useRef(Promise.resolve());
  const ready = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    ready.current = false;
    (async () => {
      const db = await getDatabase();
      await installActions();
      let fresh: Snapshot;
      const bootstrap = async (transaction: DocumentDatabase) => {
        fresh = await readWorkspace(transaction);
        const session = fresh.sessions.find(item => item.status !== 'completed') ?? fresh.sessions[0];
        if (session) await saveDocument(transaction, { id: 'focus-current', feature: 'productivity', collection: 'state',
          schemaVersion: 1, updatedAt: Date.now(), data: { sessionId: session.id } });
      };
      if (Platform.OS === 'ios') await db.withExclusiveTransactionAsync(bootstrap);
      else await db.withTransactionAsync(() => bootstrap(db));
      if (!cancelled) { setSnapshot(fresh!); ready.current = true; }
      if (actions.available) await actions.flushEffects('productivity').catch(e => { if (!cancelled) setSurfaceError(String(e)); });
    })().catch(e => { if (!cancelled) setError(String(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [attempt]);

  const refresh = useCallback(() => {
    const next = queue.current.then(async () => {
      if (!ready.current) return;
      const fresh = await readWorkspace(await getDatabase());
      if (mounted.current) { setSnapshot(fresh); setNow(Date.now()); }
      if (actions.available) await actions.flushEffects('productivity').catch(e => {
        if (mounted.current) setSurfaceError(String(e));
      });
    });
    queue.current = next.catch(e => { if (mounted.current) setError(String(e)); });
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    const native = requireOptionalNativeModule<{ addListener(event: string, listener: () => void): { remove(): void } }>('ZoridActions');
    const records = native?.addListener('onRecordsChanged', refresh);
    return () => { clearInterval(timer); subscription.remove(); records?.remove(); };
  }, [refresh]);

  const mutate = useCallback((operation: (state: Snapshot, db: DocumentDatabase) => Promise<void>, native = false) => {
    const next = queue.current.then(async () => {
      if (!ready.current) throw new Error('Local storage is not ready. Retry loading before making changes.');
      setBusy(true);
      try {
        const db = await getDatabase();
        if (native) await operation(await readWorkspace(db), db);
        else if (Platform.OS === 'ios') {
          await db.withExclusiveTransactionAsync(async transaction => operation(await readWorkspace(transaction), transaction));
        } else await db.withTransactionAsync(async () => operation(await readWorkspace(db), db));
        if (mounted.current) { setSnapshot(await readWorkspace(db)); setError(null); }
      } finally { if (mounted.current) setBusy(false); }
    });
    queue.current = next.catch(e => { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); });
    return next.then(() => true, () => false);
  }, []);

  const control = useCallback((action: 'pause' | 'resume' | 'finish') => mutate(async (state, db) => {
    const active = state.sessions.find(session => session.status !== 'completed');
    if (!active) return;
    if (actions.available) {
      const result = await actions.invoke('productivity', 'focus.control', {
        sessionId: active.id, revision: focusRevision(active), action,
      }, { bundleVersion: focusActionVersion });
      if (mounted.current) setSurfaceError(result.surfaceError ?? null);
    } else await persist(db, 'sessions', changeFocus(active, action, Date.now()));
  }, actions.available), [mutate]);

  const active = snapshot.sessions.find(session => session.status !== 'completed');
  useEffect(() => {
    if (active?.status === 'running' && workedMs(active, now) >= active.targetMs) void control('finish');
  }, [active, now, control]);
  useEffect(() => {
    if (!ready.current) return;
    if (actions.available) {
      // The handler reads current durable records. All iOS surface publications
      // use the same native sequence and lock as widget interactions.
      void actions.invoke('productivity', 'focus.publish', { action: 'publish' }, { bundleVersion: focusActionVersion })
        .then(result => { if (mounted.current) setSurfaceError(result.surfaceError ?? null); })
        .catch(() => { if (mounted.current) setSurfaceError('Native surfaces could not update. Your session is saved locally.'); });
      return;
    }
    const session = active ?? snapshot.sessions[0];
    const presentation = session ? focusSessionPresentation(session, Date.now()) : undefined;
    void publishFocus(presentation ? { taskTitle: presentation.taskTitle, status: presentation.status, presentation }
      : { taskTitle: 'Ready to focus', status: 'idle' })
      .then(result => { if (mounted.current) setSurfaceError(result.error ?? null); })
      .catch(() => { if (mounted.current) setSurfaceError('Native surfaces could not update. Your session is saved locally.'); });
  }, [active, snapshot.sessions, snapshot.focusPolicyId, loading]);

  const value: Workspace = { ...snapshot, active, loading, error, surfaceError, busy, now,
    retry: () => { if (!busy) { ready.current = false; setLoading(true); setError(null); setAttempt(n => n + 1); } }, clearError: () => setError(null),
    addTask: title => mutate(async (_state, db) => {
      const clean = title.trim(); if (!clean) return;
      await persist(db, 'tasks', { id: randomUUID(), title: clean.slice(0, 300), completed: false, createdAt: Date.now() });
    }),
    toggleTask: id => mutate(async (state, db) => {
      const task = state.tasks.find(item => item.id === id); if (!task) return;
      await persist(db, 'tasks', { ...task, completed: !task.completed });
    }),
    start: taskId => mutate(async (state, db) => {
      if (state.sessions.some(session => session.status !== 'completed')) return;
      if (actions.available) {
        const result = await actions.invoke('productivity', 'focus.start', {
          action: 'start', sessionId: randomUUID(), taskId: taskId ?? null,
        }, { bundleVersion: focusActionVersion });
        if (mounted.current) setSurfaceError(result.surfaceError ?? null);
      } else await persist(db, 'sessions', startFocus(randomUUID(), state.tasks.find(task => task.id === taskId), Date.now()));
    }, actions.available), control,
    setFocusPolicy: async policyId => {
      const saved = await mutate(async (_state, db) => {
        if (policyId !== null) {
          validateIdentifier(policyId, 'Screen Time policy ID');
          const status = await screenTime.status('productivity');
          if (!status.available || status.authorization !== 'approved') throw new Error('Authorize Screen Time before enabling app blocking.');
          if (!status.policies.some(policy => policy.id === policyId)) throw new Error('Choose apps before enabling app blocking.');
        }
        await saveDocument(db, { id: 'focus-screen-time', feature: 'productivity', collection: 'state',
          schemaVersion: 1, updatedAt: Date.now(), data: { policyId } });
      });
      if (!saved || !actions.available) return saved;
      try {
        // Commit a newer native command before an emergency direct clear, so old
        // pending activations cannot become the final state on a later retry.
        const result = await actions.invoke('productivity', 'focus.publish', { action: 'publish' }, { bundleVersion: focusActionVersion });
        if (mounted.current) setSurfaceError(result.surfaceError ?? null);
        return true;
      } catch (reason) {
        if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
        return false;
      }
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useWorkspace() { const context = useContext(Context); if (!context) throw new Error('WorkspaceProvider is missing'); return context; }
