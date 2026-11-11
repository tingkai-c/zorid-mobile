import { isFocusSession, isTask, type FocusSession, type Task } from '../domain/focus';
import { readDocuments, type DocumentDatabase } from '../storage/documents';
import { validateIdentifier } from '../actions/codec';

export type WorkspaceSnapshot = { tasks: Task[]; sessions: FocusSession[]; focusPolicyId: string | null };
export async function readWorkspace(db: DocumentDatabase): Promise<WorkspaceSnapshot> {
  const [tasks, sessions, state] = await Promise.all([
    readDocuments<Task>(db, 'productivity', 'tasks'), readDocuments<FocusSession>(db, 'productivity', 'sessions'),
    readDocuments<{ policyId: unknown }>(db, 'productivity', 'state'),
  ]);
  if (!tasks.every(record => isTask(record.data)) || !sessions.every(record => isFocusSession(record.data))) {
    throw new Error('A local record is invalid. Your data has been preserved.');
  }
  if (sessions.filter(record => record.data.status !== 'completed').length > 1) {
    throw new Error('Multiple active sessions found. Your data has been preserved.');
  }
  const setting = state.find(record => record.id === 'focus-screen-time');
  let focusPolicyId: string | null = null;
  if (setting) {
    if (!setting.data || typeof setting.data !== 'object') throw new Error('The local focus blocking setting is invalid.');
    if (setting.data.policyId !== null) validateIdentifier(setting.data.policyId, 'Screen Time policy ID');
    focusPolicyId = setting.data.policyId;
  }
  return { tasks: tasks.map(record => record.data), sessions: sessions.map(record => record.data), focusPolicyId };
}
