import { requireOptionalNativeModule } from 'expo';
import { defaultDatabaseDirectory, openDatabaseAsync } from 'expo-sqlite';
import { initializeDocuments } from './documents';

let database: ReturnType<typeof openDatabaseAsync> | undefined;
export function getDatabase() {
  if (!database) database = (async () => {
    const native = requireOptionalNativeModule<{ prepareDatabase(directory: string): Promise<string> }>('ZoridActions');
    if (!native) throw new Error('This app requires the Zorid action runtime. Install the latest native build.');
    const directory = await native.prepareDatabase(defaultDatabaseDirectory);
    const db = await openDatabaseAsync('zorid.db', {}, directory);
    await initializeDocuments(db);
    return db;
  })().catch(error => { database = undefined; throw error; });
  return database;
}
