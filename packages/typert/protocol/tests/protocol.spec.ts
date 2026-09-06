import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  bindTypertRemote,
  TypertRemoteService,
  Remote,
  RemoteScope,
  remoteMethods,
  type TypertContext,
  type TypertForwardableEvent,
  type TypertRemoteEvent,
} from '@deepseek-ai/dsh-typert-protocol'

const REMOTE_METHOD_DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Test-only one-way event: bound to no Scope and returning nothing.
     * @param value - marker payload.
     */
    'meta-fixture/forwardable'(value: string): void
    /**
     * Test-only Scope-bound event, which no carrier can deliver one-way.
     * @param value - marker payload.
     */
    'meta-fixture/scoped'(this: Context, value: string): void
    /**
     * Test-only answered event, whose result no one-way delivery can return.
     * @param value - marker payload.
     * @returns the replacement value.
     */
    'meta-fixture/answered'(value: string): string
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertContextMap {
    metaFixture: TypertContext<string>
    otherFixture: TypertContext<string>
  }

  interface TypertRemoteEventSelection extends
    Record<'meta-fixture/forwardable' | 'meta-fixture/absent', true> {}
}

describe('typert-protocol Remote declarations', () => {
  it('binds a TypertRemoteService name and executes decorators through the Vitest source transform', async () => {
    class Goals extends TypertRemoteService {
      constructor(ctx: Context) {
        super(ctx, 'goals')
      }

      @Remote({ requiredCapability: 'harniverse.observe' })
      create(value: string): string {
        return value
      }

      @RemoteScope('metaFixture', { requiredCapability: 'harniverse.operate' })
      scoped(value: string): string {
        return value
      }
    }

    class NamespacedGoals extends TypertRemoteService {
      constructor(ctx: Context) {
        super(ctx, 'internalGoals', { namespace: 'goals' })
      }
    }

    const ctx = new Context()
    const goals = new Goals(ctx)
    const namespaced = new NamespacedGoals(ctx)
    expect(goals.typertRemote).toEqual({ service: goals, serviceKey: 'goals', namespace: 'goals' })
    expect(namespaced.typertRemote).toEqual({
      service: namespaced,
      serviceKey: 'internalGoals',
      namespace: 'goals',
    })
    expect(remoteMethods(goals)).toEqual([
      { method: 'create', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.observe' },
      { method: 'scoped', invocation: { kind: 'context', context: 'metaFixture' }, requiredCapability: 'harniverse.operate' },
    ])
    await ctx.fiber.dispose()
  })

  it('executes standard decorator syntax through the TSX source launcher', () => {
    const fixture = fileURLToPath(new URL('./fixtures/source-launch.ts', import.meta.url))
    const output = execFileSync(process.execPath, ['--import', 'tsx/esm', fixture], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual([
      { method: 'create', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.observe' },
      { method: 'scoped', invocation: { kind: 'context', context: 'agent' }, requiredCapability: 'harniverse.operate' },
    ])
  })

  it('stores a non-enumerable versioned marker descriptor on the prototype', () => {
    class Goals {
      readonly typertRemote = bindTypertRemote(this, 'goals')

      create(agent: object, request: object): object {
        return { agent, request }
      }

      scoped(request: object): object {
        return request
      }
    }

    const initializers: Array<(this: Goals) => void> = []
    Remote({ requiredCapability: 'harniverse.observe' })(
      Reflect.get(Goals.prototype, 'create') as (this: Goals, ...args: unknown[]) => unknown,
      methodContext('create', initializers),
    )
    RemoteScope('metaFixture', { requiredCapability: 'harniverse.operate' })(
      Reflect.get(Goals.prototype, 'scoped') as (this: Goals, ...args: unknown[]) => unknown,
      methodContext('scoped', initializers),
    )

    const goals = new Goals()
    for (const initialize of initializers) initialize.call(goals)
    expect(goals.typertRemote).toEqual({ service: goals, serviceKey: 'goals', namespace: 'goals' })
    expect(Object.isFrozen(goals.typertRemote)).toBe(true)
    expect(remoteMethods(goals)).toEqual([
      { method: 'create', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.observe' },
      { method: 'scoped', invocation: { kind: 'context', context: 'metaFixture' }, requiredCapability: 'harniverse.operate' },
    ])
    expect(Reflect.ownKeys(Goals)).toEqual(['length', 'name', 'prototype'])
    expect(Reflect.ownKeys(Goals.prototype)).toEqual([
      'constructor', 'create', 'scoped', REMOTE_METHOD_DESCRIPTOR_KEY,
    ])
    expect(Object.keys(Goals.prototype)).toEqual([])
    expect(Object.getOwnPropertyDescriptor(Goals.prototype, REMOTE_METHOD_DESCRIPTOR_KEY)).toMatchObject({
      configurable: true,
      enumerable: false,
      writable: false,
    })
  })

  it('keeps markers idempotent across instances and returns detached snapshots', () => {
    class Service {
      run(value: string): string {
        return value
      }
    }

    const initializers: Array<(this: Service) => void> = []
    Remote({ requiredCapability: 'harniverse.observe' })(
      Reflect.get(Service.prototype, 'run') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('run', initializers),
    )

    const first = new Service()
    const second = new Service()
    for (const initialize of initializers) {
      initialize.call(first)
      initialize.call(second)
    }
    const snapshot = remoteMethods(first)
    expect(remoteMethods(second)).toEqual(snapshot)
    ;(snapshot as unknown as { method: string }[])[0]!.method = 'changed'
    expect(remoteMethods(first)).toEqual([{
      method: 'run',
      invocation: { kind: 'direct' },
      requiredCapability: 'harniverse.observe',
    }])
  })

  it.each([
    [null, 'Remote method descriptor must be an object'],
    [{ version: 2, methods: [] }, 'unsupported Remote method descriptor version 2'],
    [{ version: 1, methods: {} }, 'Remote method descriptor methods must be an array'],
  ])('rejects malformed prototype descriptor %#', (value, message) => {
    const prototype = {}
    Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR_KEY, { value })
    expect(() => remoteMethods(Object.create(prototype) as object)).toThrow(message)
  })

  it('supports explicit export names and prototype-less inputs', () => {
    class Service {
      run(value: string): string {
        return value
      }

      scoped(value: string): string {
        return value
      }
    }
    const initializers: Array<(this: Service) => void> = []
    Remote({ exportName: 'execute', requiredCapability: 'harniverse.operate' })(
      Reflect.get(Service.prototype, 'run') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('run', initializers),
    )
    RemoteScope('metaFixture', { exportName: 'inspect', requiredCapability: 'harniverse.administer' })(
      Reflect.get(Service.prototype, 'scoped') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('scoped', initializers),
    )
    const service = new Service()
    for (const initialize of initializers) initialize.call(service)

    expect(remoteMethods(service)).toEqual([
      { method: 'run', exportName: 'execute', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.operate' },
      { method: 'scoped', exportName: 'inspect', invocation: { kind: 'context', context: 'metaFixture' }, requiredCapability: 'harniverse.administer' },
    ])
    expect(remoteMethods({})).toEqual([])
    const prototypeLess: object = {}
    Reflect.setPrototypeOf(prototypeLess, null)
    expect(remoteMethods(prototypeLess)).toEqual([])
  })

  it('rejects malformed decorator calls and targets', () => {
    const method: (this: object) => void = function (this: object): void {}
    expect(() => Remote({ requiredCapability: 'invalid' as 'harniverse.observe' })).toThrow('requiredCapability')
    expect(() => Remote({ exportName: 'bad/name', requiredCapability: 'harniverse.observe' })).toThrow('export name')
    expect(() => Remote({ exportName: '.', requiredCapability: 'harniverse.observe' })).toThrow('export name')
    expect(() => RemoteScope('' as 'metaFixture', { requiredCapability: 'harniverse.observe' })).toThrow('Scope key')
    expect(() => RemoteScope('metaFixture', {
      exportName: 'bad/name', requiredCapability: 'harniverse.observe',
    })).toThrow('export name')

    for (const context of [
      { ...methodContext('run', []), private: true },
      { ...methodContext('run', []), static: true },
      { ...methodContext('run', []), name: Symbol('run') },
    ]) {
      expect(() => { Remote({ requiredCapability: 'harniverse.observe' })(method, context) })
        .toThrow('public instance method')
    }
  })

  it('rejects prototype-less initialization and conflicting markers', () => {
    const method: (this: object) => void = function (this: object): void {}
    const direct: Array<(this: object) => void> = []
    Remote({ requiredCapability: 'harniverse.observe' })(method, methodContext('run', direct))
    const prototypeLess: object = {}
    Reflect.setPrototypeOf(prototypeLess, null)
    expect(() => { direct[0]!.call(prototypeLess) }).toThrow('without a prototype')

    class Service {
      run(): void {}
    }
    const conflicting: Array<(this: Service) => void> = []
    Remote({ requiredCapability: 'harniverse.observe' })(
      Reflect.get(Service.prototype, 'run'),
      methodContext('run', conflicting),
    )
    RemoteScope('metaFixture', { requiredCapability: 'harniverse.observe' })(
      Reflect.get(Service.prototype, 'run'),
      methodContext('run', conflicting),
    )
    const service = new Service()
    conflicting[0]!.call(service)
    expect(() => { conflicting[1]!.call(service) }).toThrow('conflicting invocation markers')

    class ScopedService {
      run(): void {}
    }
    const firstScope: Array<(this: ScopedService) => void> = []
    const otherScope: Array<(this: ScopedService) => void> = []
    RemoteScope('metaFixture', { requiredCapability: 'harniverse.observe' })(
      Reflect.get(ScopedService.prototype, 'run'),
      methodContext('run', firstScope),
    )
    RemoteScope('otherFixture', { requiredCapability: 'harniverse.observe' })(
      Reflect.get(ScopedService.prototype, 'run'),
      methodContext('run', otherScope),
    )
    const scopedService = new ScopedService()
    firstScope[0]!.call(scopedService)
    expect(() => { otherScope[0]!.call(scopedService) }).toThrow('conflicting invocation markers')

    class ReverseService {
      run(): void {}
    }
    const scopedFirst: Array<(this: ReverseService) => void> = []
    const directSecond: Array<(this: ReverseService) => void> = []
    RemoteScope('metaFixture', { requiredCapability: 'harniverse.observe' })(
      Reflect.get(ReverseService.prototype, 'run'),
      methodContext('run', scopedFirst),
    )
    Remote({ requiredCapability: 'harniverse.observe' })(
      Reflect.get(ReverseService.prototype, 'run'),
      methodContext('run', directSecond),
    )
    const reverseService = new ReverseService()
    scopedFirst[0]!.call(reverseService)
    expect(() => { directSecond[0]!.call(reverseService) }).toThrow('conflicting invocation markers')
  })

  it('rejects ambiguous binding names', () => {
    expect(() => bindTypertRemote({}, '')).toThrow('service key')
    expect(() => bindTypertRemote({}, 'goals', { namespace: 'api/goals' })).toThrow('namespace')
    expect(() => bindTypertRemote({}, 'goals', { namespace: 'api goals' })).toThrow('namespace')
  })

  it('admits only one-way event shapes and only selected events that exist', () => {
    expectTypeOf<'meta-fixture/forwardable'>().toExtend<TypertForwardableEvent>()
    expectTypeOf<'meta-fixture/scoped'>().not.toExtend<TypertForwardableEvent>()
    expectTypeOf<'meta-fixture/answered'>().not.toExtend<TypertForwardableEvent>()

    expectTypeOf<'meta-fixture/forwardable'>().toExtend<TypertRemoteEvent>()
    expectTypeOf<'meta-fixture/scoped'>().not.toExtend<TypertRemoteEvent>()
    expectTypeOf<'meta-fixture/absent'>().not.toExtend<TypertRemoteEvent>()
  })
})

function methodContext<This extends object>(
  name: string,
  initializers: Array<(this: This) => void>,
): ClassMethodDecoratorContext<This, (this: This, ...args: unknown[]) => unknown> {
  return {
    kind: 'method',
    name,
    static: false,
    private: false,
    metadata: {},
    access: {
      has: object => name in object,
      get: object => (object as Record<string, unknown>)[name] as (this: This, ...args: unknown[]) => unknown,
    },
    addInitializer: (initializer) => { initializers.push(initializer) },
  }
}
