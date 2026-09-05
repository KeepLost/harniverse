/**
 * Remote decorators and explicit Gateway bindings backed by versioned
 * descriptors carried on decorated class prototypes. Strict reflection
 * remains a Typert compiler responsibility.
 * @module @deepseek-ai/dsh-typert-protocol
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { AuthenticationCapability } from '@deepseek-ai/dsh-authentication'
import type { TypertContextMap } from './types.ts'

const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Test one generated Remote name against the Connection endpoint grammar.
 * @param value - namespace, method, lookup, or Context segment.
 * @returns whether the value can cross the shared RPC carrier unchanged.
 */
export function isTypertRemoteSegment(value: string): boolean {
  return value !== '.' && value !== '..' && TYPERT_REMOTE_SEGMENT_PATTERN.test(value)
}

/**
 * A lookup policy rejection whose typed payload belongs to the active boundary adapter.
 * Gateway adapters preserve this payload instead of collapsing it into an infrastructure failure.
 */
export class TypertLookupFailure<Failure = unknown> extends Error {
  /** Adapter-owned failure returned to the caller. */
  readonly failure: Failure

  /**
   * Wrap one adapter failure without exposing the rejected identity.
   * @param failure - typed failure owned by the active boundary adapter.
   */
  constructor(failure: Failure) {
    super('Typert lookup policy rejected the requested identity')
    this.name = 'TypertLookupFailure'
    this.failure = failure
  }
}

export type {
  InvocationDescriptor,
  InvocationParameterDescriptor,
  InvocationSourceLocation,
  RemoteFailure,
  RemoteResult,
  TypertClientRemote,
  TypertClientContextBinder,
  TypertCodec,
  TypertContext,
  TypertContextMap,
  TypertContextRegistry,
  TypertContextWire,
  TypertDisposer,
  TypertForwardableEvent,
  TypertHostContextProvider,
  TypertHostContextResolver,
  TypertLocalRegistry,
  TypertLookup,
  TypertLookupDefinition,
  TypertLookupHost,
  TypertLookupMap,
  TypertLookupProvider,
  TypertLookupResolver,
  TypertLookupRegistry,
  TypertLookupWire,
  TypertRemoteScopeApi,
  TypertRemoteScopeMap,
  TypertRemoteScopeNamespace,
  TypertRemoteContribution,
  TypertRemoteEvent,
  TypertRemoteEventSelection,
  TypertRemoteMap,
  TypertRemoteNamespace,
  TypertRemoteNamespaceMap,
  TypertRemoteRegistry,
  TypertRegistryChange,
  TypertRegistryListener,
  TypertSchema,
  TypertRegistryContract,
} from './types.ts'

/** Options for an explicit Service-to-Gateway binding. */
export interface TypertGatewayBindingOptions {
  /** Wire namespace; defaults to the Cordis service key. */
  readonly namespace?: string
}

/** Visible declaration that one Service participates in Typert Gateway export. */
export interface TypertGatewayBinding<Service extends object = object> {
  readonly service: Service
  readonly serviceKey: string
  readonly namespace: string
}

/** Invocation mode recorded by a Remote method decorator. */
export type RemoteInvocationMarker =
  | { readonly kind: 'direct' }
  | { readonly kind: 'context'; readonly context: string }

/** One decorator marker discovered for a live Service instance. */
export interface RemoteMethodMarker {
  /** Public instance method carrying the implementation. */
  readonly method: string
  /** Endpoint method when it differs from the implementation member. */
  readonly exportName?: string
  readonly invocation: RemoteInvocationMarker
  /** Capability required before Gateway dispatch. */
  readonly requiredCapability: AuthenticationCapability
}

/** Required authorization metadata and optional alias for one Remote method. */
export interface RemoteOptions {
  readonly requiredCapability: AuthenticationCapability
  readonly exportName?: string
}

type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void

interface RemoteInitializerContext<This extends object> {
  readonly private: boolean
  readonly static: boolean
  readonly name: string | symbol
  addInitializer(initializer: (this: This) => void): void
}

interface StoredRemoteMethodMarker {
  readonly exportName?: string
  readonly invocation: RemoteInvocationMarker
  readonly requiredCapability: AuthenticationCapability
}

interface StoredRemoteMethod extends StoredRemoteMethodMarker {
  readonly method: string
}

interface RemoteMethodDescriptorV1 {
  readonly version: 1
  readonly methods: readonly StoredRemoteMethod[]
}

const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Bind one visible Service field to a Cordis key and Remote namespace.
 * @param service - owning Service instance, normally `this`.
 * @param serviceKey - exact Cordis service key.
 * @param options - optional distinct wire namespace.
 * @returns a frozen, inspectable binding with no compiler-injected metadata.
 */
export function bindTypertRemote<Service extends object>(
  service: Service,
  serviceKey: string,
  options: TypertGatewayBindingOptions = {},
): TypertGatewayBinding<Service> {
  validateName('service key', serviceKey)
  const namespace = options.namespace ?? serviceKey
  validateName('namespace', namespace)
  return Object.freeze({ service, serviceKey, namespace })
}

/** Cordis Service base that exposes its registered name through Typert Gateway. */
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  /** Visible binding consumed by the Gateway's source-mode discovery. */
  readonly typertRemote: TypertGatewayBinding<this>

  /**
   * Register the Service and bind the same key to Typert Gateway.
   * @param ctx - owning Cordis Context.
   * @param serviceKey - exact Cordis service key and default wire namespace.
   * @param options - optional distinct wire namespace.
   */
  protected constructor(ctx: Context, serviceKey: string, options: TypertGatewayBindingOptions = {}) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)
  }
}

/**
 * Mark one public instance method as a capability-gated Remote invocation.
 * @param options - required capability and optional exported method alias.
 * @returns a standard method decorator.
 */
export function Remote(options: RemoteOptions): RemoteMethodDecorator {
  validateRemoteOptions(options)
  return function <This extends object, Args extends unknown[], Result>(
    _method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void {
    addMarkerInitializer(context, { kind: 'direct' }, options)
  }
}

/**
 * Create a decorator for a method resolved from one Remote Scope.
 * @param key - scope key declared through the Context map.
 * @param options - required capability and optional exported method alias.
 * @returns a standard method decorator that records a versioned prototype descriptor.
 */
export function RemoteScope(
  key: Extract<keyof TypertContextMap, string>,
  options: RemoteOptions,
): RemoteMethodDecorator {
  validateName('Scope key', key)
  validateRemoteOptions(options)
  return function <This extends object, Args extends unknown[], Result>(
    _method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void {
    addMarkerInitializer(context, { kind: 'context', context: key }, options)
  }
}

/**
 * Read Remote markers attached to a live Service's class prototype.
 * The returned snapshot cannot mutate the stored descriptor.
 * @param service - live Service instance.
 * @returns markers in class declaration order.
 */
export function remoteMethods(service: object): readonly RemoteMethodMarker[] {
  const prototype = Object.getPrototypeOf(service) as object | null
  if (prototype === null) return []
  return (readRemoteMethodDescriptor(prototype)?.methods ?? []).map(marker => ({ ...marker }))
}

function readRemoteMethodDescriptor(prototype: object): RemoteMethodDescriptorV1 | undefined {
  const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)
  if (property === undefined) return undefined
  const descriptor: unknown = property.value
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new TypeError('typert-protocol: Remote method descriptor must be an object')
  }
  const version: unknown = Reflect.get(descriptor, 'version')
  if (version !== 1) {
    throw new TypeError(`typert-protocol: unsupported Remote method descriptor version ${String(version)}`)
  }
  const methods: unknown = Reflect.get(descriptor, 'methods')
  if (!Array.isArray(methods)) {
    throw new TypeError('typert-protocol: Remote method descriptor methods must be an array')
  }
  return descriptor as RemoteMethodDescriptorV1
}

function addMarkerInitializer<This extends object>(
  context: RemoteInitializerContext<This>,
  invocation: RemoteInvocationMarker,
  options: RemoteOptions,
): void {
  if (context.private || context.static || typeof context.name !== 'string') {
    throw new TypeError('typert-protocol: Remote decorators require a public instance method with a string name')
  }
  const method = context.name
  context.addInitializer(function (this: This) {
    const prototype = Object.getPrototypeOf(this) as object | null
    if (prototype === null) {
      throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`)
    }
    mark(prototype, method, invocation, options)
  })
}

function mark(
  prototype: object,
  method: string,
  invocation: RemoteInvocationMarker,
  options: RemoteOptions,
): void {
  const descriptor = readRemoteMethodDescriptor(prototype)
  const marker: StoredRemoteMethod = Object.freeze({
    method,
    ...(options.exportName === undefined || options.exportName === method ? {} : { exportName: options.exportName }),
    invocation: Object.freeze(invocation),
    requiredCapability: options.requiredCapability,
  })
  const current = descriptor?.methods.find(candidate => candidate.method === method)
  if (current !== undefined) {
    if (current.exportName === marker.exportName
      && current.requiredCapability === marker.requiredCapability
      && sameInvocation(current.invocation, invocation)) return
    throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`)
  }
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([...(descriptor?.methods ?? []), marker]),
    } satisfies RemoteMethodDescriptorV1),
  })
}

function validateRemoteOptions(options: RemoteOptions): void {
  if (!isSupportedCapability(options.requiredCapability)) {
    throw new TypeError('typert-protocol: Remote requiredCapability is invalid')
  }
  if (options.exportName !== undefined) validateName('Remote export name', options.exportName)
}

function isSupportedCapability(value: unknown): value is AuthenticationCapability {
  return value === 'harniverse.observe'
    || value === 'harniverse.operate'
    || value === 'harniverse.administer'
    || value === 'harniverse.authorize'
}

function sameInvocation(left: RemoteInvocationMarker, right: RemoteInvocationMarker): boolean {
  return left.kind === right.kind
    && (left.kind === 'direct' || (right.kind === 'context' && left.context === right.context))
}

function validateName(subject: string, value: string): void {
  if (!isTypertRemoteSegment(value)) {
    throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`)
  }
}
