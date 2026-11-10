import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { initializeDocuments, readDocuments, saveDocument, type DocumentDatabase } from '../src/storage/documents';
const connections: Database[] = [];
function database(): DocumentDatabase {
  const db = new Database(':memory:'); connections.push(db);
  return { async execAsync(sql) { db.exec(sql); }, async runAsync(sql, ...params) { return db.run(sql, params); }, async getAllAsync<T>(sql: string, ...params: (string | number | null)[]) { return db.query(sql).all(...params) as T[]; } };
}
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
test('documents preserve flexible JSON and isolate feature namespaces', async () => {
  const db = database(); await initializeDocuments(db);
  const document = { id: 'same-id', feature: 'notes', collection: 'records', schemaVersion: 1, updatedAt: 1, data: { title: "It's local", properties: { tags: ['work'] } } };
  await saveDocument(db, document); await saveDocument(db, { ...document, feature: 'tasks', data: { title: 'Task', properties: { tags: [] } } });
  expect((await readDocuments(db, 'notes', 'records'))[0]).toEqual(document);
  await saveDocument(db, { ...document, updatedAt: 2 });
  expect(await readDocuments(db, 'notes', 'records')).toHaveLength(1);
  expect((await readDocuments(db, 'tasks', 'records'))[0]?.data).toEqual({ title: 'Task', properties: { tags: [] } });
});
test('future record versions fail explicitly rather than silently corrupting records', async () => {
  const db = database(); await initializeDocuments(db);
  await saveDocument(db, { id: 'x', feature: 'notes', collection: 'records', schemaVersion: 2, updatedAt: 0, data: {} });
  expect(readDocuments(db, 'notes', 'records')).rejects.toThrow('Unsupported records record version');
});
