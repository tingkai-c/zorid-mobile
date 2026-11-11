import { isFocusSession, isTask, type FocusSession, type Task } from '../domain/focus';
import { readDocuments, type DocumentDatabase } from '../storage/documents';

export type WorkspaceSnapshot = { tasks: Task[]; sessions: FocusSession[] };
export async function readWorkspace(db: DocumentDatabase): Promise<WorkspaceSnapshot> {
  const [tasks, sessions] = await Promise.all([
    readDocuments<Task>(db, 'productivity', 'tasks'), readDocuments<FocusSession>(db, 'productivity', 'sessions'),
  ]);
  if (!tasks.every(record => isTask(record.data)) || !sessions.every(record => isFocusSession(record.data))) {
    throw new Error('A local record is invalid. Your data has been preserved.');
  }
  if (sessions.filter(record => record.data.status !== 'completed').length > 1) {
    throw new Error('Multiple active sessions found. Your data has been preserved.');
  }
  return { tasks: tasks.map(record => record.data), sessions: sessions.map(record => record.data) };
}
