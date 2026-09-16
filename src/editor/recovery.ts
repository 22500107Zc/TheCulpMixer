import { SerializedScene } from '../scene/Scene';

/**
 * Crash recovery.
 *
 * The first version of this put one autosave in `localStorage`. That storage
 * is a few megabytes, shared with everything else the origin keeps, and it is
 * synchronous — so the moment a scene carried a subdivided mesh or an embedded
 * texture, autosave started failing exactly when the work was most worth
 * keeping, and the writes that did land stalled the frame.
 *
 * IndexedDB has room for real scenes and writes off the main thread. It also
 * lets us keep a few autosaves rather than one, which matters: the copy you
 * want back is often not the newest one, because the newest one may already
 * contain the mistake. `localStorage` stays as a fallback for the rare context
 * where IndexedDB is missing or blocked.
 */

const DB_NAME = 'The Culp Mixer';
/** The database name before the application was renamed. */
const LEGACY_DB_NAME = 'kiln';
const DB_VERSION = 1;
const STORE = 'recovery';
const LS_KEY = 'culpmixer.autosave';
/** The localStorage fallback key before the rename. */
const LEGACY_LS_KEY = 'kiln.autosave';

export interface RecoverySlot {
  id: number;
  savedAt: number;
  name: string;
  objectCount: number;
  bytes: number;
}

export interface StoredRecovery extends RecoverySlot {
  scene: SerializedScene;
}

export interface SaveResult {
  ok: boolean;
  reason?: string;
  bytes?: number;
  where?: 'indexeddb' | 'localstorage';
}

export interface RecoveryBackend {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
  put(rec: StoredRecovery): Promise<void>;
  list(): Promise<RecoverySlot[]>;
  get(id: number): Promise<StoredRecovery | null>;
  remove(id: number): Promise<void>;
  clear(): Promise<void>;
}

// -------------------------------------------------------------- IndexedDB

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the recovery database'));
    // A blocked open means another tab holds an older version open. Nothing
    // useful to do but fail, so the caller can fall back.
    req.onblocked = () => reject(new Error('The recovery database is in use by another tab'));
  });
}

/**
 * Anything left in the database from before the application was renamed.
 *
 * IndexedDB names are not aliases — a rename simply points at an empty
 * database, and whatever was in the old one is still on disk and completely
 * unreachable. That is somebody's unsaved work, so it is read once and copied
 * across the first time the new database is opened.
 *
 * Best-effort throughout: an absent legacy database, a blocked open, or a
 * browser that never had one all mean the same thing here, which is nothing
 * to carry over.
 */
async function adoptLegacyRecovery(into: IDBDatabase): Promise<void> {
  const existing = await new Promise<unknown[]>((resolve) => {
    try {
      const t = into.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
  // Only ever into an empty store, so this cannot overwrite newer work.
  if (existing.length > 0) return;

  const legacy = await new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const done = (value: IDBDatabase | null): void => {
      if (!settled) { settled = true; resolve(value); }
    };
    try {
      const req = indexedDB.open(LEGACY_DB_NAME);
      // Opening a database that does not exist creates an empty one; the
      // upgrade callback firing is how we know there was nothing there.
      req.onupgradeneeded = () => { req.transaction?.abort(); done(null); };
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
      setTimeout(() => done(null), 2000);
    } catch {
      done(null);
    }
  });
  if (!legacy) return;
  try {
    if (!legacy.objectStoreNames.contains(STORE)) return;
    const records = await new Promise<StoredRecovery[]>((resolve) => {
      try {
        const t = legacy.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result ?? []) as StoredRecovery[]);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    if (records.length === 0) return;
    await new Promise<void>((resolve) => {
      try {
        const t = into.transaction(STORE, 'readwrite');
        const store = t.objectStore(STORE);
        for (const record of records) store.put(record);
        t.oncomplete = () => resolve();
        t.onerror = () => resolve();
        t.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } finally {
    legacy.close();
  }
}

export function indexedDbBackend(): RecoveryBackend | null {
  if (typeof indexedDB === 'undefined') return null;
  let db: Promise<IDBDatabase> | null = null;
  const handle = (): Promise<IDBDatabase> => (db ??= openDatabase().then(async (opened) => {
    await adoptLegacyRecovery(opened).catch(() => { /* nothing to carry over */ });
    return opened;
  }));

  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T> => {
    const d = await handle();
    const t = d.transaction(STORE, mode);
    const result = await fn(t.objectStore(STORE));
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('Recovery write failed'));
      t.onabort = () => reject(t.error ?? new Error('Recovery write was aborted'));
    });
    return result;
  };

  return {
    kind: 'indexeddb',
    put: (rec) => tx('readwrite', async (s) => void (await idbRequest(s.put(rec)))),
    get: (id) => tx('readonly', async (s) => (await idbRequest(s.get(id))) ?? null),
    remove: (id) => tx('readwrite', async (s) => void (await idbRequest(s.delete(id)))),
    clear: () => tx('readwrite', async (s) => void (await idbRequest(s.clear()))),
    list: () =>
      tx('readonly', async (s) => {
        const all = (await idbRequest(s.getAll())) as StoredRecovery[];
        return all.map(({ scene: _scene, ...meta }) => meta).sort((a, b) => b.savedAt - a.savedAt);
      }),
  };
}

// ----------------------------------------------------------- localStorage

function localStore(): Storage | null {
  try {
    const s = window.localStorage;
    // Safari in private mode hands back an object that throws on write.
    s.setItem('__culpmixer_probe__', '1');
    s.removeItem('__culpmixer_probe__');
    return s;
  } catch {
    return null;
  }
}

export function localStorageBackend(): RecoveryBackend | null {
  const s = localStore();
  if (!s) return null;
  const read = (): StoredRecovery[] => {
    try {
      // The name this key had before the application was renamed is still
      // read: someone whose browser crashed under the old name should get
      // their work back under the new one.
      const raw = s.getItem(LS_KEY) ?? s.getItem(LEGACY_LS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      // The old format was a single record rather than a list.
      const list: StoredRecovery[] = Array.isArray(parsed) ? parsed : [{ id: 1, objectCount: 0, bytes: 0, ...parsed }];
      return list.filter((r) => r && r.scene);
    } catch {
      return [];
    }
  };
  const write = (list: StoredRecovery[]): void => {
    s.setItem(LS_KEY, JSON.stringify(list));
  };
  return {
    kind: 'localstorage',
    async put(rec) {
      write([rec, ...read().filter((r) => r.id !== rec.id)]);
    },
    async list() {
      return read().map(({ scene: _scene, ...meta }) => meta).sort((a, b) => b.savedAt - a.savedAt);
    },
    async get(id) {
      return read().find((r) => r.id === id) ?? null;
    },
    async remove(id) {
      write(read().filter((r) => r.id !== id));
    },
    async clear() {
      s.removeItem(LS_KEY);
    },
  };
}

/** An in-memory backend, for tests and for contexts with no storage at all. */
export function memoryBackend(): RecoveryBackend {
  const map = new Map<number, StoredRecovery>();
  return {
    kind: 'memory',
    async put(rec) {
      map.set(rec.id, rec);
    },
    async list() {
      return [...map.values()].map(({ scene: _scene, ...meta }) => meta).sort((a, b) => b.savedAt - a.savedAt);
    },
    async get(id) {
      return map.get(id) ?? null;
    },
    async remove(id) {
      map.delete(id);
    },
    async clear() {
      map.clear();
    },
  };
}

// ------------------------------------------------------------------ store

export class RecoveryStore {
  private backend: RecoveryBackend | null = null;
  private tried = false;
  /** Serializes writes so a slow save cannot overlap the next one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private keep = 5) {}

  /**
   * IndexedDB first, localStorage second, memory last. Resolved once and
   * remembered — a browser that refuses IndexedDB will refuse it every time,
   * and retrying on each autosave would just stall the tick.
   */
  private async resolveBackend(): Promise<RecoveryBackend> {
    if (this.backend) return this.backend;
    if (!this.tried) {
      this.tried = true;
      const idb = indexedDbBackend();
      if (idb) {
        try {
          await idb.list();
          this.backend = idb;
          return idb;
        } catch {
          /* fall through to the next option */
        }
      }
      this.backend = localStorageBackend() ?? memoryBackend();
    }
    return this.backend ?? memoryBackend();
  }

  /** Force a particular backend. Tests use this; the app does not. */
  use(backend: RecoveryBackend): void {
    this.backend = backend;
    this.tried = true;
  }

  get kind(): string {
    return this.backend?.kind ?? 'unresolved';
  }

  save(scene: SerializedScene, name: string): Promise<SaveResult> {
    const run = async (): Promise<SaveResult> => {
      const rec: StoredRecovery = {
        id: Date.now(),
        savedAt: Date.now(),
        name,
        objectCount: scene.objects?.length ?? 0,
        bytes: 0,
        scene,
      };
      let backend = await this.resolveBackend();
      // localStorage needs the string anyway, and the size is worth reporting
      // either way. IndexedDB stores the structured value, not the text.
      if (backend.kind !== 'indexeddb') rec.bytes = JSON.stringify(scene).length;
      try {
        await backend.put(rec);
      } catch (err) {
        // Usually the quota. Making room by dropping older copies is worth one
        // try; falling back to localStorage is worth another, but only from
        // IndexedDB — never to memory, because a recovery copy that dies with
        // the tab is not a recovery copy, and saying so beats pretending.
        let retried = await this.prune(backend, 1).catch(() => false);
        if (!retried && backend.kind === 'indexeddb') {
          const ls = localStorageBackend();
          if (ls) {
            backend = ls;
            this.backend = ls;
            rec.bytes = JSON.stringify(scene).length;
            retried = true;
          }
        }
        if (!retried) {
          return { ok: false, reason: (err as Error).message || 'Storage refused the scene', bytes: rec.bytes };
        }
        try {
          await backend.put(rec);
        } catch {
          return { ok: false, reason: (err as Error).message || 'Storage refused the scene', bytes: rec.bytes };
        }
      }
      await this.prune(backend, this.keep).catch(() => false);
      return { ok: true, bytes: rec.bytes, where: backend.kind === 'indexeddb' ? 'indexeddb' : 'localstorage' };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async prune(backend: RecoveryBackend, keep: number): Promise<boolean> {
    const slots = await backend.list();
    if (slots.length <= keep) return false;
    for (const slot of slots.slice(keep)) await backend.remove(slot.id);
    return true;
  }

  async list(): Promise<RecoverySlot[]> {
    try {
      return await (await this.resolveBackend()).list();
    } catch {
      return [];
    }
  }

  /** The newest slot, which is what the recovery bar offers. */
  async latest(): Promise<StoredRecovery | null> {
    const slots = await this.list();
    if (slots.length === 0) return null;
    return this.load(slots[0].id);
  }

  async load(id: number): Promise<StoredRecovery | null> {
    try {
      return await (await this.resolveBackend()).get(id);
    } catch {
      return null;
    }
  }

  async discard(id?: number): Promise<void> {
    try {
      const backend = await this.resolveBackend();
      if (id === undefined) await backend.clear();
      else await backend.remove(id);
    } catch {
      /* a recovery copy we cannot delete is not worth interrupting anyone over */
    }
  }
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
