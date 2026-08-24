import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'

const TEST_AUTHENTICATION = { getSnapshot: () => ({ kind: 'bypass' as const }), subscribe: () => () => {}, validate: () => true }
import { SettingsScopeController } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-scope.ts'
import { decodeWelcomeSection, WelcomeNoticeStore } from '../src/client/welcome-store.ts'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'

let rpc = 0

function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `welcome-${rpc++}` as never, result: { ok: true, value } }
}

function namespace(value: unknown = {}, revision = 0) {
  return {
    ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
    schema: {},
    value,
    applies: 'live' as const,
    secrets: [],
    revision,
  }
}

function buildWelcome(api: { describe: ReturnType<typeof vi.fn>; mutate?: ReturnType<typeof vi.fn> }) {
  const wire = { settings: api } as never
  const mirror = new SettingsDescribeMirror(wire, TEST_AUTHENTICATION)
  const scope = new SettingsScopeController(
    wire,
    { namespace: WELCOME_NOTICE_SETTINGS_NAMESPACE, decode: decodeWelcomeSection },
    mirror,
  )
  return { mirror, controller: new WelcomeNoticeStore(scope) }
}

describe('WelcomeNoticeStore', () => {
  it('acknowledges only the exact current copy version', async () => {
    for (const [version, acknowledged] of [
      [undefined, false],
      ['older-copy', false],
      [WELCOME_NOTICE_VERSION, true],
    ] as const) {
      const describeCall = vi.fn().mockResolvedValue(ok({
        writable: true,
        hasDocument: false,
        namespaces: [namespace(version === undefined ? {} : { [WELCOME_NOTICE_ACK_FIELD]: version })],
      }))
      const { mirror, controller } = buildWelcome({ describe: describeCall })
      await mirror.load()
      await controller.load()
      expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged })
    }
  })

  it('persists through one revision-fenced mutation and folds the response', async () => {
    const describeCall = vi.fn().mockResolvedValue(ok({
      writable: true, hasDocument: false, namespaces: [namespace({}, 3)],
    }))
    const mutate = vi.fn().mockResolvedValue(ok(namespace({
      [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION,
    }, 4)))
    const { mirror, controller } = buildWelcome({ describe: describeCall, mutate })
    await mirror.load()
    await controller.load()

    await expect(controller.acknowledge()).resolves.toBe(true)

    expect(mutate).toHaveBeenCalledWith({
      ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
      ops: [{ op: 'set', path: [WELCOME_NOTICE_ACK_FIELD], value: WELCOME_NOTICE_VERSION }],
      expectedRevision: 3,
    })
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true })
    expect(describeCall).toHaveBeenCalledOnce()
  })

  it('reports a failed persistence attempt after mirror recovery', async () => {
    const describeCall = vi.fn().mockResolvedValue(ok({
      writable: true, hasDocument: false, namespaces: [namespace()],
    }))
    const mutate = vi.fn().mockRejectedValue(new Error('disk full'))
    const { mirror, controller } = buildWelcome({ describe: describeCall, mutate })
    await mirror.load()
    await controller.load()

    await expect(controller.acknowledge()).resolves.toBe(false)

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'error', acknowledged: false, error: 'the acknowledgement did not persist',
    })
    expect(describeCall).toHaveBeenCalledTimes(2)
  })

  it('clears acknowledgement when the namespace is no longer authorized', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(ok({
        writable: true,
        hasDocument: false,
        namespaces: [namespace({ [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION })],
      }))
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: false, namespaces: [] }))
    const { mirror, controller } = buildWelcome({ describe: describeCall })
    await mirror.load()
    await controller.load()
    expect(controller.store.getSnapshot().acknowledged).toBe(true)

    await mirror.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'error', acknowledged: false,
    })
  })

  it('clears acknowledgement synchronously at an authentication boundary', async () => {
    const describeCall = vi.fn().mockResolvedValue(ok({
      writable: true,
      hasDocument: false,
      namespaces: [namespace({ [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION })],
    }))
    const { mirror, controller } = buildWelcome({ describe: describeCall })
    await mirror.load()
    await controller.load()
    expect(controller.store.getSnapshot().acknowledged).toBe(true)

    mirror.reset()

    expect(controller.store.getSnapshot()).toEqual({ status: 'loading', acknowledged: false, error: null })
  })

  it('clears acknowledgement while saving and ignores the prior-principal settlement', async () => {
    const write = Promise.withResolvers<ReturnType<typeof ok<ReturnType<typeof namespace>>>>()
    const describeCall = vi.fn().mockResolvedValue(ok({
      writable: true,
      hasDocument: false,
      namespaces: [namespace({ [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION }, 1)],
    }))
    const { mirror, controller } = buildWelcome({
      describe: describeCall,
      mutate: vi.fn(() => write.promise),
    })
    await mirror.load()
    await controller.load()
    const saving = controller.acknowledge()
    await Promise.resolve()
    expect(controller.store.getSnapshot().status).toBe('saving')

    mirror.reset()

    expect(controller.store.getSnapshot()).toEqual({ status: 'loading', acknowledged: false, error: null })
    write.resolve(ok(namespace({ [WELCOME_NOTICE_ACK_FIELD]: WELCOME_NOTICE_VERSION }, 2)))
    await expect(saving).resolves.toBe(false)
    expect(controller.store.getSnapshot()).toEqual({ status: 'loading', acknowledged: false, error: null })
  })
})
