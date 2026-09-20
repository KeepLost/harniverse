/**
 * Coordinated boot-layer configuration reloads. The vendored Cordis HMR
 * plugin owns module replacement and Include refresh with internal,
 * uncoordinated concurrency; this additive layer gives the reload work
 * Harniverse initiates (user patch layers, profile patches) one exclusive
 * queue with consecutive-change merging, nesting rejection, failure
 * broadcast, and disposal drain.
 * @module @deepseek-ai/dsh-hmr-coordination
 */

import { watch, type FSWatcher } from 'chokidar'
import { existsSync, realpathSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    hmrCoordination: HmrReloadCoordinator
  }

  interface Events {
    /**
     * A watched coordination config refresh failed.
     * @param filename - Canonical path watched by the coordinator.
     * @param error - Normalized refresh failure.
     * @mode parallel
     */
    'hmr-coordination/config-update-failed'(filename: string, error: Error): Promise<void> | void
  }
}

/** Failure sink the plugin supplies: broadcast plus warning log. */
export interface HmrCoordinationOptions {
  /** Called once per failed refresh pass with the canonical filename. */
  readonly onFailure?: (filename: string, error: Error) => void
}

interface WatchRegistration {
  readonly watcher: FSWatcher
  readonly refresh: () => Promise<void> | void
  running: Promise<void> | undefined
}

/**
 * Canonicalize a watched path: symlinks resolve when the file exists,
 * otherwise the absolute lexical path is the stable identity.
 */
function canonicalPath(absolute: string): string {
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/**
 * Nearest existing ancestor directory of the watched file: chokidar cannot
 * watch a missing directory, so a not-yet-created patch file watches its
 * nearest existing ancestor at a bounded depth.
 */
function findWatchRoot(absolute: string): string {
  let current = dirname(absolute)
  for (;;) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    /* v8 ignore next 2 -- the filesystem root always exists; the guard only bounds the loop against a disappearing ancestor. */
    if (parent === current) return current
    current = parent
  }
}

/**
 * Exclusive reload queue plus exact-path config watchers for boot layers.
 * Module replacement and Include refresh stay with the vendored HMR plugin;
 * this coordinator owns only the reloads Harniverse registers.
 */
export class HmrReloadCoordinator {
  readonly #registrations = new Map<string, WatchRegistration>()
  readonly #onFailure: ((filename: string, error: Error) => void) | undefined
  readonly #storage = new AsyncLocalStorage<object>()
  #operations: Promise<unknown> = Promise.resolve()
  #closing = false

  constructor(options: HmrCoordinationOptions = {}) {
    this.#onFailure = options.onFailure
  }

  /**
   * Run one task on the exclusive queue.
   * @param task - reload work; a refresh may await other fibers.
   * @returns the task's own settlement.
   * @throws when called from inside a queued task, or after disposal.
   */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new Error('HMR coordination is disposed'))
    if (this.#storage.getStore() !== undefined) {
      return Promise.reject(new Error('coordinated reloads cannot be nested'))
    }
    const run = this.#operations.then(() => this.#storage.run({}, task))
    this.#operations = run.then(() => {}, () => {})
    return run
  }

  /**
   * Watch one exact config file and reload it through the exclusive queue.
   * Consecutive writes during a refresh merge into one additional pass.
   * @param filename - config file path; missing parents are supported.
   * @param refresh - reload work for that file.
   * @returns an asynchronous disposer; the watcher buffers events until ready.
   * @throws when the canonical path is already registered or the coordinator is disposed.
   */
  watchConfig(filename: string, refresh: () => Promise<void> | void): () => Promise<void> {
    if (this.#closing) throw new Error('HMR coordination is disposed')
    const absolute = resolve(filename)
    const canonical = canonicalPath(absolute)
    if (this.#registrations.has(canonical)) {
      throw new Error(`HMR coordination: ${canonical} is already registered`)
    }
    const watchRoot = findWatchRoot(absolute)
    const targetBelowRoot = relative(watchRoot, absolute)
    const depth = targetBelowRoot.split(sep).length - 1
    const watcher = watch(watchRoot, { depth, awaitWriteFinish: true })
    const registration: WatchRegistration = { watcher, refresh, running: undefined }
    // `pending` is closure-captured: an event during an in-flight pass reruns
    // the refresh once, merging consecutive writes into one additional pass.
    let pending = false
    const runPass = async (): Promise<void> => {
      pending = false
      try {
        await registration.refresh()
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason })
        this.#onFailure?.(canonical, error)
      }
    }
    const dispatch = () => {
      /* v8 ignore next 2 -- after disposal the watchers are closed, so only an event already in flight can race the closing flag. */
      if (this.#closing) return
      pending = true
      if (registration.running !== undefined) return
      registration.running = this.runExclusive(async () => {
        await runPass()
        while (pending) await runPass()
      }).finally(() => {
        registration.running = undefined
      })
    }
    const onTargetEvent = (path: string) => {
      if (resolve(path) !== absolute) return
      dispatch()
    }
    watcher.on('add', onTargetEvent)
    watcher.on('change', onTargetEvent)
    watcher.on('unlink', onTargetEvent)
    this.#registrations.set(canonical, registration)
    return async () => {
      this.#registrations.delete(canonical)
      await watcher.close()
      const running = registration.running
      if (running !== undefined && this.#storage.getStore() === undefined) await running
    }
  }


  /**
   * Stop accepting reloads, close every watcher, and drain the queue.
   * Calling from inside a queued task skips the self-wait.
   * @returns settlement after in-flight work has drained.
   */
  async dispose(): Promise<void> {
    this.#closing = true
    await Promise.all([...this.#registrations.values()].map(registration => registration.watcher.close()))
    this.#registrations.clear()
    // #operations swallows every queued failure at enqueue, so the tail never
    // rejects; from inside a queued task, awaiting it would self-deadlock.
    if (this.#storage.getStore() === undefined) await this.#operations
  }
}

/**
 * Cordis plugin providing the shared `ctx.hmrCoordination` service.
 * @param ctx - app context owning the coordination lifetime.
 */
export const apply = (ctx: Context) => {
  const coordinator = new HmrReloadCoordinator({
    onFailure: (filename, error) => {
      ctx.logger.warn('coordinated config reload at %C failed', filename)
      ctx.logger.warn(error)
      void ctx.parallel('hmr-coordination/config-update-failed', filename, error)
    },
  })
  ctx.provide('hmrCoordination', coordinator)
  ctx.effect(() => () => {
    void coordinator.dispose()
  }, 'hmr-coordination: service lifecycle')
}

/** Cordis plugin name. */
export const name = 'hmr-coordination'
