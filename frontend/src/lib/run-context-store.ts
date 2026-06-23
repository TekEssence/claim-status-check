import type { FileSystemFileHandle } from "../types/file-system-access";

const DB_NAME = "iehp-claim-status-check";
const STORE_NAME = "run-context";
const CLAIM_FILE_HANDLE_KEY = "iehp-claim-file-handle";
const IEHP_LOGIN_FILE_KEY = "iehp-login-file";

function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => reject(transaction.error);
      action(store, resolve, reject);
    };
  });
}

async function setValue<T>(key: string, value: T): Promise<void> {
  await withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getValue<T>(key: string): Promise<T | null> {
  return withStore<T | null>("readonly", (store, resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function deleteValue(key: string): Promise<void> {
  await withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function saveClaimFileHandle(handle: FileSystemFileHandle): Promise<void> {
  await setValue(CLAIM_FILE_HANDLE_KEY, handle);
}

export async function loadClaimFileHandle(): Promise<FileSystemFileHandle | null> {
  return getValue<FileSystemFileHandle>(CLAIM_FILE_HANDLE_KEY);
}

export async function clearClaimFileHandle(): Promise<void> {
  await deleteValue(CLAIM_FILE_HANDLE_KEY);
}

export async function saveIehpLoginFile(file: File): Promise<void> {
  await setValue(IEHP_LOGIN_FILE_KEY, file);
}

export async function loadIehpLoginFile(): Promise<File | null> {
  return getValue<File>(IEHP_LOGIN_FILE_KEY);
}

export async function clearIehpLoginFile(): Promise<void> {
  await deleteValue(IEHP_LOGIN_FILE_KEY);
}

export async function clearStoredRunContext(): Promise<void> {
  await Promise.allSettled([clearClaimFileHandle(), clearIehpLoginFile()]);
}
