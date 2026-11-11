export type Document<T> = { id: string; feature: string; collection: string; schemaVersion: number; updatedAt: number; data: T };
export interface DocumentDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: (string | number | null)[]): Promise<unknown>;
  getAllAsync<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
}
export async function initializeDocuments(db: DocumentDatabase) {
  await db.execAsync(`PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 1000;
    CREATE TABLE IF NOT EXISTS documents (
      feature TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
      schema_version INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(feature, collection, id));`);
}
export async function saveDocument<T>(db: DocumentDatabase, document: Document<T>) {
  await db.runAsync(`INSERT INTO documents(feature, collection, id, schema_version, updated_at, data)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(feature, collection, id) DO UPDATE SET
    schema_version=excluded.schema_version, updated_at=excluded.updated_at, data=excluded.data`,
  document.feature, document.collection, document.id, document.schemaVersion, document.updatedAt, JSON.stringify(document.data));
}
export async function readDocuments<T>(db: DocumentDatabase, feature: string, collection: string): Promise<Document<T>[]> {
  const rows = await db.getAllAsync<{id: string; schema_version: number; updated_at: number; data: string}>(
    'SELECT id, schema_version, updated_at, data FROM documents WHERE feature = ? AND collection = ? ORDER BY updated_at DESC', feature, collection);
  return rows.map(row => {
    if (row.schema_version !== 1) throw new Error(`Unsupported ${collection} record version: ${row.schema_version}`);
    return { id: row.id, feature, collection, schemaVersion: row.schema_version, updatedAt: row.updated_at, data: JSON.parse(row.data) as T };
  });
}
