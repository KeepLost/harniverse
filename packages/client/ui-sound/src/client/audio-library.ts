/**
 * The per-browser audio file library: local notification sounds live in an
 * IndexedDB object store (`dsh-ui-sound-audio` / `files`), keeping blobs out
 * of the durable settings document. Records carry the original file name so
 * the settings page can label them without decoding audio.
 */

/** One stored audio record. */
export interface StoredAudioRecord {
  blob: Blob
  name: string
}

/** Async face over one audio record store (IndexedDB in production). */
export interface AudioRecordStore {
  /** Persist one record under its id; false when storage is unavailable. */
  put(id: string, record: StoredAudioRecord): Promise<boolean>
  /** Read one record; undefined when absent or storage is unavailable. */
  get(id: string): Promise<StoredAudioRecord | undefined>
  /** Remove one record; storage failures resolve silently. */
  delete(id: string): Promise<boolean>
}

/**
 * Browser audio library: one lazily-created store plus the reference helpers
 * the settings page and the playback engine need. References are
 * `audio:<id>` strings; ids stay opaque outside this module.
 */
export class AudioLibrary {
  private store: Promise<AudioRecordStore> | undefined

  /**
   * @param openStore - the store factory (swappable for tests).
   */
  constructor(private readonly openStore: () => Promise<AudioRecordStore>) {}

  /**
   * Store one chosen file and return its `audio:<id>` reference.
   *
   * @param file - the audio file the browser picker produced.
   * @param name - the file's display name.
   * @returns the stored reference, or `local` when storage is unavailable.
   */
  async save(file: Blob, name: string): Promise<string> {
    const store = await this.ensure()
    const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    return await store.put(id, { blob: file, name }) ? `audio:${id}` : 'local'
  }

  /**
   * Read one reference's stored record.
   *
   * @param id - reference id without the `audio:` prefix.
   * @returns the record, or undefined when this browser never stored it.
   */
  async load(id: string): Promise<StoredAudioRecord | undefined> {
    return await (await this.ensure()).get(id)
  }

  /**
   * Remove one reference's record (the replace flow drops the orphaned file).
   *
   * @param id - reference id without the `audio:` prefix.
   */
  async remove(id: string): Promise<void> {
    await (await this.ensure()).delete(id)
  }

  /** Create the store once per instance. */
  private ensure(): Promise<AudioRecordStore> {
    this.store ??= this.openStore()
    return this.store
  }
}

/** Build the production IndexedDB-backed store; an in-memory empty one when unavailable. */
export function openBrowserAudioStore(): Promise<AudioRecordStore> {
  const indexedDB = (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (indexedDB === undefined) return Promise.resolve(emptyStore())
  return new Promise((resolve) => {
    const request = indexedDB.open('dsh-ui-sound-audio', 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('files')) database.createObjectStore('files')
    }
    request.onsuccess = () => { resolve(recordStoreOf(request.result)) }
    request.onerror = () => { resolve(emptyStore()) }
    request.onblocked = () => { resolve(emptyStore()) }
  })
}

/** Adapt one open database into the async record-store face. */
function recordStoreOf(database: IDBDatabase): AudioRecordStore {
  const run = <T>(use: (store: IDBObjectStore) => IDBRequest<T> | undefined): Promise<{ ok: boolean; value: T | undefined }> =>
    new Promise((resolve) => {
      const transaction = database.transaction('files', 'readwrite')
      const request = use(transaction.objectStore('files'))
      transaction.oncomplete = () => { resolve({ ok: true, value: request?.result }) }
      transaction.onerror = () => { resolve({ ok: false, value: undefined }) }
      transaction.onabort = () => { resolve({ ok: false, value: undefined }) }
    })
  return {
    async put(id, record) {
      return (await run<void>((store) => { store.put(record, id); return undefined })).ok
    },
    async get(id) {
      return (await run<StoredAudioRecord | undefined>(
        store => store.get(id) as IDBRequest<StoredAudioRecord | undefined>,
      )).value
    },
    async delete(id) {
      return (await run<void>((store) => { store.delete(id); return undefined })).ok
    },
  }
}

/** The no-storage store: reads miss and writes report failure. */
function emptyStore(): AudioRecordStore {
  return {
    put: () => Promise.resolve(false),
    get: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(false),
  }
}
