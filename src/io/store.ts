import type { LibraryTool } from '../cam/tools/library';
import type { JobFile } from './formats';

/**
 * Browser-side working copy (IndexedDB): the current tool library, an autosave of each open job,
 * and the recent-jobs list. This is a cache for convenience: the files on disk are the master
 * copies (see files.ts). If IndexedDB is unavailable (private window, blocked storage) the store
 * keeps everything in memory for the session and `persistent` is false.
 */

const DB_NAME = 'onefinity-cam';
const DB_VERSION = 1;

export interface JobRecord {
  /** stable id for the job in this browser */
  id: string;
  job: JobFile;
  /** file name it was last opened from / saved to, if any */
  fileName?: string;
  /** changed since it was last saved to a file */
  dirty: boolean;
  updated: number;
}

export interface LibraryRecord {
  name: string;
  tools: LibraryTool[];
  dirty?: boolean;
}

export interface Store {
  /** false when only held in memory */
  readonly persistent: boolean;
  getLibrary(): Promise<LibraryRecord | null>;
  /** dirty = changed since it was last saved to / opened from a file */
  putLibrary(name: string, tools: LibraryTool[], dirty?: boolean): Promise<void>;
  getJob(id: string): Promise<JobRecord | null>;
  putJob(rec: JobRecord): Promise<void>;
  deleteJob(id: string): Promise<void>;
  /** most recently changed first */
  recentJobs(limit?: number): Promise<JobRecord[]>;
  /** font files the user loaded (TTF/OTF/WOFF), by name */
  putFont(name: string, data: ArrayBuffer): Promise<void>;
  getFont(name: string): Promise<ArrayBuffer | null>;
  listFonts(): Promise<string[]>;
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = idb.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('updated', 'updated');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('storage is open in an older tab; close it and reload'));
  });
}

class IdbStore implements Store {
  readonly persistent = true;
  constructor(private db: IDBDatabase) {}
  private tx(store: string, mode: IDBTransactionMode) {
    return this.db.transaction(store, mode).objectStore(store);
  }
  async getLibrary() {
    return ((await req(this.tx('kv', 'readonly').get('library'))) as LibraryRecord | undefined) ?? null;
  }
  async putLibrary(name: string, tools: LibraryTool[], dirty = false) {
    await req(this.tx('kv', 'readwrite').put({ name, tools, dirty }, 'library'));
  }
  async getJob(id: string) {
    return ((await req(this.tx('jobs', 'readonly').get(id))) as JobRecord | undefined) ?? null;
  }
  async putJob(rec: JobRecord) {
    await req(this.tx('jobs', 'readwrite').put(rec));
  }
  async deleteJob(id: string) {
    await req(this.tx('jobs', 'readwrite').delete(id));
  }
  async recentJobs(limit = 20) {
    const all = (await req(this.tx('jobs', 'readonly').index('updated').getAll())) as JobRecord[];
    return all.reverse().slice(0, limit);
  }
  async putFont(name: string, data: ArrayBuffer) {
    await req(this.tx('kv', 'readwrite').put(data, `font:${name}`));
  }
  async getFont(name: string) {
    return ((await req(this.tx('kv', 'readonly').get(`font:${name}`))) as ArrayBuffer | undefined) ?? null;
  }
  async listFonts() {
    const keys = (await req(this.tx('kv', 'readonly').getAllKeys())) as IDBValidKey[];
    return keys.map(String).filter((k) => k.startsWith('font:')).map((k) => k.slice(5)).sort();
  }
}

class MemoryStore implements Store {
  readonly persistent = false;
  private lib: LibraryRecord | null = null;
  private jobs = new Map<string, JobRecord>();
  async getLibrary() {
    return this.lib ? structuredClone(this.lib) : null;
  }
  async putLibrary(name: string, tools: LibraryTool[], dirty = false) {
    this.lib = structuredClone({ name, tools, dirty });
  }
  async getJob(id: string) {
    const r = this.jobs.get(id);
    return r ? structuredClone(r) : null;
  }
  async putJob(rec: JobRecord) {
    this.jobs.set(rec.id, structuredClone(rec));
  }
  async deleteJob(id: string) {
    this.jobs.delete(id);
  }
  async recentJobs(limit = 20) {
    return [...this.jobs.values()].sort((a, b) => b.updated - a.updated).slice(0, limit).map((r) => structuredClone(r));
  }
  private fonts = new Map<string, ArrayBuffer>();
  async putFont(name: string, data: ArrayBuffer) {
    this.fonts.set(name, data);
  }
  async getFont(name: string) {
    return this.fonts.get(name) ?? null;
  }
  async listFonts() {
    return [...this.fonts.keys()].sort();
  }
}

/**
 * Opens the store. Also asks the browser to keep this site's storage (not evict it when the disk
 * gets full); `storagePersisted` says whether it agreed.
 */
export async function openStore(idb: IDBFactory | null = globalThis.indexedDB ?? null): Promise<{ store: Store; storagePersisted: boolean }> {
  let storagePersisted = false;
  try {
    storagePersisted = (await navigator.storage?.persist?.()) ?? false;
  } catch {
    /* not supported */
  }
  if (!idb) return { store: new MemoryStore(), storagePersisted: false };
  try {
    return { store: new IdbStore(await openDb(idb)), storagePersisted };
  } catch {
    return { store: new MemoryStore(), storagePersisted: false };
  }
}

export const newJobId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
