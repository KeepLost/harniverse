/**
 * The session standard-props provide channel: provider roster, scope-binding
 * materialization (fail-loud on undeclared/missing/duplicate members), the
 * static no-session projection, and the atomic current-session projection
 * observable. One implementation — SessionRuntime drives it from wire
 * truth, the test runtime's sessions double drives it from fixtures — so
 * the materialization rules and the projection semantics cannot drift
 * between production and the test bench.
 */
import type {
  HostObservable, KeyedStandardSource, ScopedStandardSourceBinding, StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionBinding, SessionProvideDescriptor } from '../contract/session-state.ts'

/** The owner-side hooks: how the channel reaches the owner's live bundles and current selection. */
export interface SessionProvideChannelHost {
  /**
   * Re-materialize every already-materialized bundle against the new roster
   * (call {@link SessionProvideChannel.materializeBinding} per live binding).
   * Lazily-materialized sessions pick the new roster up on first resolve.
   */
  rebuildBundles(): void
  /** Resolve the current selection's binding (the owner's maybe-provide lookup). */
  resolveCurrent(): StandardSourceBinding
}

/**
 * Provider roster + materialization + current projection. The channel owns
 * every rule a provider contribution must satisfy; owners keep only their
 * per-session binding storage and the definition of "current". Materialized
 * values are renderer-standard scope bindings: the runtime's own builtin
 * descriptor contributes the `session` hook, the `projection` keyed hook,
 * and the `sessionId` prop — every further member arrives through
 * `sessions.provide` descriptors.
 */
export class SessionProvideChannel {
  private readonly providers: SessionProvideDescriptor[] = []
  private absentBindingCache: StandardSourceBinding
  /** Latest published current binding (identity comparison dedupes republish). */
  private currentSnapshot: StandardSourceBinding
  /** Projection subscribers (plain cell: bindings hold live session sources, so no store freeze may touch them). */
  private readonly listeners = new Set<() => void>()

  /**
   * Atomic current-session scope-binding projection: selection changes and
   * provider-roster changes publish through this one source, so a roster
   * change under a stable current id republishes the binding instead of
   * stranding mounted entries.
   */
  readonly currentScopeBinding: HostObservable<StandardSourceBinding>

  /** Stable observable of the static absent projection (explicit-target resolution and scope-adapter wiring). */
  readonly absentSource: HostObservable<StandardSourceBinding>

  /**
   * @param host - owner-side binding storage and current-selection resolution.
   */
  constructor(private readonly host: SessionProvideChannelHost) {
    // The runtime's own contribution comes first: useSession and the
    // useProjection keyed seat ride the same provide channel every plugin
    // uses (no renderer special case).
    this.providers.push({
      hooks: ['session'],
      keyedHooks: ['projection'],
      props: ['sessionId'],
      resolve: binding => ({
        hooks: { session: binding.session },
        keyedHooks: { projection: key => binding.session.projections.faceOf(key) },
        props: { sessionId: binding.sessionId },
      }),
    })
    this.absentBindingCache = this.materializeAbsentBinding()
    this.currentSnapshot = this.absentBindingCache
    const snapshot = (): StandardSourceBinding => this.currentSnapshot
    this.currentScopeBinding = {
      getSnapshot: snapshot,
      subscribe: (fn) => {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
    }
    this.absentSource = {
      getSnapshot: (): StandardSourceBinding => this.absentBindingCache,
      subscribe: (fn) => {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
    }
  }

  /** The static no-session projection under the current roster (declared names present, values undefined). */
  get absentBinding(): StandardSourceBinding {
    return this.absentBindingCache
  }

  /** Renew blank-session injection identity when the machine owning the sources changes. */
  resetTarget(): void {
    this.absentBindingCache = this.materializeAbsentBinding()
    this.publishCurrent()
  }

  /**
   * Register a per-session standard-props provider (see
   * SessionRuntime.provide for the product contract). Live bindings rebuild
   * immediately; misdeclared providers fail loud here, at the registration
   * edge, and the registration rolls back — the channel never stays on a
   * roster it cannot materialize.
   * @param descriptor - static member roster plus per-session resolver.
   * @returns disposer removing the provider.
   */
  provide(descriptor: SessionProvideDescriptor): () => void {
    this.providers.push(descriptor)
    try {
      this.applyRosterChange()
    } catch (error) {
      this.providers.splice(this.providers.indexOf(descriptor), 1)
      // Restore the previous (valid) roster's bindings; cannot rethrow — the
      // pre-push roster materialized successfully before.
      this.applyRosterChange()
      throw error
    }
    return () => {
      const at = this.providers.indexOf(descriptor)
      if (at >= 0) this.providers.splice(at, 1)
      this.applyRosterChange()
    }
  }

  /**
   * Re-derive the current selection's binding and publish it when it changed.
   * Bindings are identity-stable per (scope, roster) materialization, so an
   * identity compare is exact; synchronous notify — call sites (the owner's
   * list subscription, provide()) already sit behind their own batching or
   * registration edges.
   */
  publishCurrent(): void {
    const next = this.host.resolveCurrent()
    if (next === this.currentSnapshot) return
    this.currentSnapshot = next
    for (const fn of [...this.listeners]) {
      try {
        fn()
      } catch (error) {
        // Contain subscriber failures: this notify runs inside the list
        // notification, where a throwing render-side subscriber would starve
        // later listeners and abort the projection pass that scheduled it.
        console.error('sessions.currentScopeBinding subscriber failed:', error)
      }
    }
  }

  /**
   * Materialize the standard-props scope binding for one session (fails loud
   * on undeclared, missing, and duplicate member names).
   * @param binding - session assembly handle fed to every resolver.
   * @returns the materialized binding (identity-stable until the next materialization).
   */
  materializeBinding(binding: SessionBinding): ScopedStandardSourceBinding {
    const hooks: Record<string, HostObservable<unknown>> = {}
    const keyedHooks: Record<string, KeyedStandardSource> = {}
    const props: Record<string, unknown> = {}
    for (const descriptor of this.providers) {
      const contribution = descriptor.resolve(binding)
      const contributedHooks = contribution.hooks ?? {}
      const contributedKeyedHooks = contribution.keyedHooks ?? {}
      const contributedProps = contribution.props ?? {}
      for (const name of Object.keys(contributedHooks)) {
        if (!(descriptor.hooks ?? []).includes(name)) {
          throw new Error(`sessions.provide: undeclared hook "${name}"`)
        }
      }
      for (const name of Object.keys(contributedKeyedHooks)) {
        if (!(descriptor.keyedHooks ?? []).includes(name)) {
          throw new Error(`sessions.provide: undeclared keyed hook "${name}"`)
        }
      }
      for (const name of Object.keys(contributedProps)) {
        if (!(descriptor.props ?? []).includes(name)) {
          throw new Error(`sessions.provide: undeclared prop "${name}"`)
        }
      }
      for (const name of descriptor.hooks ?? []) {
        const source = contributedHooks[name]
        if (source === undefined) throw new Error(`sessions.provide: missing hook "${name}"`)
        if (Object.hasOwn(hooks, name)) throw new Error(`sessions.provide: duplicate hook "${name}"`)
        hooks[name] = source
      }
      for (const name of descriptor.keyedHooks ?? []) {
        const resolver = contributedKeyedHooks[name]
        if (resolver === undefined) throw new Error(`sessions.provide: missing keyed hook "${name}"`)
        if (Object.hasOwn(keyedHooks, name)) throw new Error(`sessions.provide: duplicate keyed hook "${name}"`)
        keyedHooks[name] = resolver
      }
      for (const name of descriptor.props ?? []) {
        if (!Object.hasOwn(contributedProps, name)) throw new Error(`sessions.provide: missing prop "${name}"`)
        if (Object.hasOwn(props, name)) throw new Error(`sessions.provide: duplicate prop "${name}"`)
        props[name] = contributedProps[name]
      }
    }
    return {
      key: binding.sessionId,
      // The per-session AgentContext is the binding's generation identity:
      // the renderer remounts strict-session subtrees when it changes and the
      // slot registry releases store-scope generations through it.
      ctx: binding.ctx,
      hooks,
      keyedHooks,
      props,
    }
  }

  /** Rebuild the static projection and the owner's live bindings, then republish the current one. */
  private applyRosterChange(): void {
    this.absentBindingCache = this.materializeAbsentBinding()
    this.host.rebuildBundles()
    this.publishCurrent()
  }

  /** Build the static no-session kit and reject duplicate declared names. */
  private materializeAbsentBinding(): StandardSourceBinding {
    const hooks: Record<string, undefined> = {}
    const keyedHooks: Record<string, undefined> = {}
    const props: Record<string, undefined> = {}
    for (const descriptor of this.providers) {
      for (const name of descriptor.hooks ?? []) {
        if (Object.hasOwn(hooks, name)) throw new Error(`sessions.provide: duplicate hook "${name}"`)
        hooks[name] = undefined
      }
      for (const name of descriptor.keyedHooks ?? []) {
        if (Object.hasOwn(keyedHooks, name)) throw new Error(`sessions.provide: duplicate keyed hook "${name}"`)
        keyedHooks[name] = undefined
      }
      for (const name of descriptor.props ?? []) {
        if (Object.hasOwn(props, name)) throw new Error(`sessions.provide: duplicate prop "${name}"`)
        props[name] = undefined
      }
    }
    return { key: undefined, hooks, keyedHooks, props }
  }
}
