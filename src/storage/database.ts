import { openDatabaseAsync } from 'expo-sqlite';
import { initializeDocuments } from './documents';
let database: ReturnType<typeof openDatabaseAsync> | undefined;
export function getDatabase() {
  if (!database) database = openDatabaseAsync('zorid.db').then(async db => {
    await initializeDocuments(db); return db;
  }).catch(error => { database = undefined; throw error; });
  return database;
}
