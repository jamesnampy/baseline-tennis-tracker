import type { IdentityMapping, MatchRecord, PlayerProfile } from "./model.ts";

const DB_NAME = "baseline-tennis-tracker";
const STORE_NAME = "matches";
const PLAYER_STORE = "players";
const MAPPING_STORE = "identity_mappings";
const DB_VERSION = 2;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PLAYER_STORE)) db.createObjectStore(PLAYER_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MAPPING_STORE)) db.createObjectStore(MAPPING_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function put<T>(storeName: string, value: T): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction(storeName, "readwrite"); tx.objectStore(storeName).put(value); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
}

async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await openDatabase();
  const rows = await new Promise<T[]>((resolve, reject) => { const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll(); request.onsuccess = () => resolve(request.result as T[]); request.onerror = () => reject(request.error); });
  db.close(); return rows;
}

export const savePlayer = (player: PlayerProfile) => put(PLAYER_STORE, player);
export const loadPlayers = () => getAll<PlayerProfile>(PLAYER_STORE).then((rows) => rows.sort((a, b) => a.displayName.localeCompare(b.displayName)));
export const saveIdentityMapping = (mapping: IdentityMapping) => put(MAPPING_STORE, mapping);
export const loadIdentityMappings = () => getAll<IdentityMapping>(MAPPING_STORE);

export async function saveMatch(match: MatchRecord): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(match);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function loadMatches(): Promise<MatchRecord[]> {
  const db = await openDatabase();
  const records = await new Promise<MatchRecord[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as MatchRecord[]);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteMatch(id: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}
