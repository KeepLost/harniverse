/** The audio library: reference lifecycle over the record-store face and the IndexedDB adapter. */

import { afterEach, describe, expect, it } from 'vitest'
import { AudioLibrary, openBrowserAudioStore } from '../src/client/audio-library.ts'
import type { AudioRecordStore, StoredAudioRecord } from '../src/client/audio-library.ts'

/** In-memory record store double. */
function fakeStore(entries: ReadonlyArray<[string, StoredAudioRecord]> = [], fail = false): AudioRecordStore {
  const records = new Map(entries)
  return {
    async put(id, record) {
      if (fail) return false
      records.set(id, record)
      return true
    },
    async get(id) { return records.get(id) },
    async delete(id) {
      if (fail) return false
      return records.delete(id)
    },
  }
}

describe('AudioLibrary', () => {
  it('saves a file under an audio reference and reads it back', async () => {
    const library = new AudioLibrary(async () => fakeStore())
    const blob = new Blob(['bytes'], { type: 'audio/wav' })
    const reference = await library.save(blob, 'bell.wav')
    expect(reference.startsWith('audio:')).toBe(true)
    const record = await library.load(reference.slice('audio:'.length))
    expect(record?.name).toBe('bell.wav')
    expect(record?.blob).toBe(blob)
  })

  it('degrades to the pending-local value when storage refuses writes', async () => {
    const library = new AudioLibrary(async () => fakeStore([], true))
    await expect(library.save(new Blob(['x']), 'n.wav')).resolves.toBe('local')
  })

  it('removes one reference and reads missing ids as undefined', async () => {
    const library = new AudioLibrary(async () => fakeStore())
    const reference = await library.save(new Blob(['x']), 'n.wav')
    await library.remove(reference.slice('audio:'.length))
    await expect(library.load(reference.slice('audio:'.length))).resolves.toBeUndefined()
  })
})

/** Minimal IndexedDB doubles exercising the production adapter. */
class FakeIDBRequest<T> {
  result: T | undefined
  onsuccess: (() => void) | null = null
  onerror: (() => void) | null = null
  onblocked: (() => void) | null = null
  onupgradeneeded: (() => void) | null = null
  constructor(result?: T) { this.result = result }
  succeed(): void { this.onsuccess?.() }
  fail(): void { this.onerror?.() }
  block(): void { this.onblocked?.() }
}

class FakeObjectStore {
  readonly data = new Map<string, StoredAudioRecord>()
  readonly requests: FakeIDBRequest<unknown>[] = []
  put(record: StoredAudioRecord, id: string): FakeIDBRequest<unknown> {
    this.data.set(id, record)
    const request = new FakeIDBRequest<unknown>()
    this.requests.push(request)
    return request
  }

  get(id: string): FakeIDBRequest<unknown> {
    const request = new FakeIDBRequest<unknown>(this.data.get(id))
    this.requests.push(request)
    return request
  }

  delete(id: string): FakeIDBRequest<unknown> {
    this.data.delete(id)
    const request = new FakeIDBRequest<unknown>()
    this.requests.push(request)
    return request
  }
}

/** One open transaction; requests settle then the transaction completes or errors. */
class FakeTransaction {
  readonly store: FakeObjectStore
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  constructor(store: FakeObjectStore) { this.store = store }
  objectStore(): FakeObjectStore { return this.store }
  settle(outcome: 'complete' | 'error' | 'abort'): void {
    for (const request of this.store.requests.splice(0)) request.succeed()
    if (outcome === 'complete') this.oncomplete?.()
    else if (outcome === 'error') this.onerror?.()
    else this.onabort?.()
  }
}

class FakeDatabase {
  readonly objectStore = new FakeObjectStore()
  readonly transactions: FakeTransaction[] = []
  hasStore = false
  readonly objectStoreNames = { contains: (name: string): boolean => name === 'files' && this.hasStore }
  createObjectStore(): FakeObjectStore {
    this.hasStore = true
    return this.objectStore
  }
  transaction(): FakeTransaction {
    const transaction = new FakeTransaction(this.objectStore)
    this.transactions.push(transaction)
    return transaction
  }

  /** Settle the most recently opened transaction (the production cycle is one at a time). */
  settle(outcome: 'complete' | 'error' | 'abort'): void {
    this.transactions.shift()?.settle(outcome)
  }
}

/** Install one fake indexedDB factory on globalThis for one test. */
function installFakeIndexedDB(database: FakeDatabase, settle: 'succeed' | 'fail' | 'block' = 'succeed'): () => void {
  const previous = (globalThis as { indexedDB?: unknown }).indexedDB
  const openRequest = new FakeIDBRequest<FakeDatabase>(database)
  ;(globalThis as { indexedDB?: unknown }).indexedDB = { open: (): FakeIDBRequest<FakeDatabase> => openRequest }
  queueMicrotask(() => {
    openRequest.onupgradeneeded?.()
    if (settle === 'fail') openRequest.fail()
    else if (settle === 'block') openRequest.block()
    else openRequest.succeed()
  })
  return () => { (globalThis as { indexedDB?: unknown }).indexedDB = previous }
}

describe('openBrowserAudioStore', () => {
  const restores: Array<() => void> = []
  afterEach(() => {
    for (const restore of restores.splice(0)) restore()
  })

  it('degrades to the empty store without IndexedDB', async () => {
    const restore = installFakeIndexedDB(new FakeDatabase())
    restores.push(restore)
    ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined
    const store = await openBrowserAudioStore()
    await expect(store.put('a1', { blob: new Blob(['x']), name: 'n.wav' })).resolves.toBe(false)
    await expect(store.get('a1')).resolves.toBeUndefined()
    await expect(store.delete('a1')).resolves.toBe(false)
  })

  it('creates the object store on first open and round-trips records', async () => {
    const database = new FakeDatabase()
    const restore = installFakeIndexedDB(database)
    restores.push(restore)
    const storePromise = openBrowserAudioStore()
    await new Promise<void>((resolve) => { queueMicrotask(() => { resolve() }) })
    const store = await storePromise
    const put = store.put('a1', { blob: new Blob(['x']), name: 'n.wav' })
    database.settle('complete')
    await expect(put).resolves.toBe(true)
    const read = store.get('a1')
    database.settle('complete')
    const stored = await read
    expect(stored?.name).toBe('n.wav')
    expect(stored?.blob).toBeInstanceOf(Blob)
    const gone = store.delete('a1')
    database.settle('complete')
    await expect(gone).resolves.toBe(true)

    // A second open on the upgraded database skips store creation.
    const reopenRestore = installFakeIndexedDB(database)
    restores.push(reopenRestore)
    await expect(openBrowserAudioStore()).resolves.toBeDefined()
  })

  it('degrades to the empty store when the open is blocked or fails', async () => {
    const blockedRestore = installFakeIndexedDB(new FakeDatabase(), 'block')
    restores.push(blockedRestore)
    const blocked = openBrowserAudioStore()
    await new Promise<void>((resolve) => { queueMicrotask(() => { resolve() }) })
    await expect((await blocked).put('a', { blob: new Blob(['x']), name: 'n.wav' })).resolves.toBe(false)

    const failedRestore = installFakeIndexedDB(new FakeDatabase(), 'fail')
    restores.push(failedRestore)
    const failed = openBrowserAudioStore()
    await new Promise<void>((resolve) => { queueMicrotask(() => { resolve() }) })
    await expect((await failed).get('a1')).resolves.toBeUndefined()
  })

  it('reports an aborted transaction as a failed write', async () => {
    const database = new FakeDatabase()
    const restore = installFakeIndexedDB(database)
    restores.push(restore)
    const store = await openBrowserAudioStore()
    const put = store.put('a1', { blob: new Blob(['x']), name: 'n.wav' })
    database.settle('abort')
    await expect(put).resolves.toBe(false)
  })

  it('reports failures through the transaction error path', async () => {
    const database = new FakeDatabase()
    const restore = installFakeIndexedDB(database)
    restores.push(restore)
    const store = await openBrowserAudioStore()
    const put = store.put('a1', { blob: new Blob(['x']), name: 'n.wav' })
    database.settle('error')
    await expect(put).resolves.toBe(false)
  })
})
