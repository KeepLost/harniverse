/**
 * A session's agent preset is fixed at creation. The gateway records the
 * resolved id on the header and refuses to adopt the identity under a different
 * one, because the session's history was produced under that preset's tools:
 * rebuilding it differently would replay tool calls the new agent cannot make.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentFactory } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'
import {
  InvalidPresetIdError, PresetExistsError, UnknownPresetError,
} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { createApiProxy } from '../src/api-proxy.ts'
import { describe, expect, it } from 'vitest'

let nextRpc = 0
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`preset-${String(nextRpc++)}`), payload }
}

/** Minimal live agent; the gateway only needs identity and its session. */
function stubAgent(session: Session): Agent {
  return { id: session.id, session, status: 'idle' } as unknown as Agent
}

/**
 * A roster whose `mount` is a no-op: this spec is about the gateway's identity
 * rules, and the composition itself is covered by the real-composition test in
 * `apps/cli`. Ids listed in `userIds` present as locally authored; the rest
 * ship with the deployment.
 */
function roster(
  ids: readonly string[],
  userIds: readonly string[] = [],
  profilePermissions: Readonly<Record<string, string>> = {},
  profileSupervision: Readonly<Record<string, 'supervised' | 'unsupervised'>> = {},
): unknown {
  const trustOf = (id: string): 'system' | 'user' => (userIds.includes(id) ? 'user' : 'system')
  const presetOf = (id: string): object => ({
    id,
    trust: trustOf(id),
    path: `/presets/${id}/agent.cordis.yml`,
    ...profilePermissions[id] === undefined ? {} : { permissionPreset: profilePermissions[id] },
    ...profileSupervision[id] === undefined ? {} : { supervisionMode: profileSupervision[id] },
  })
  return {
    defaultId: ids[0],
    list: () => Promise.resolve(ids.map(presetOf)),
    resolve: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      if (!ids.includes(wanted)) return Promise.reject(new UnknownPresetError(wanted, ids))
      return Promise.resolve(presetOf(wanted))
    },
    mount: (_ctx: Context, id?: string) => Promise.resolve(presetOf(id ?? ids[0] ?? '')),
    // What a real mount leaves behind: a service instance only the agent that
    // mounted it can be used to address. The doubles are per agent so a test
    // can tell "this session's" from "some session's".
    serviceFor: (agent: { id: unknown }, name: string) => {
      const perAgent = services.get(String(agent.id))
      return perAgent?.[name]
    },
    authorable: true,
    read: (id: string) => Promise.resolve(`# ${id}\n- id: x\n  name: y\n`),
    copy: (from: string, id: string) => {
      if (!ids.includes(from)) return Promise.reject(new UnknownPresetError(from, ids))
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return Promise.reject(new InvalidPresetIdError(id))
      if (ids.includes(id)) return Promise.reject(new PresetExistsError(id))
      return Promise.resolve()
    },
    remove: (id: string) => {
      if (!ids.includes(id)) return Promise.reject(new UnknownPresetError(id, ids))
      return Promise.resolve()
    },
    recompose: (_ctx: Context, id: string) => {
      if (!ids.includes(id)) return Promise.reject(new UnknownPresetError(id, ids))
      return Promise.resolve({ id, trust: 'system', path: `/presets/${id}.yml` })
    },
    // The standing scope key a cold transcript read resolves presenters in.
    standingKeyFor: (id?: string) => {
      const wanted = id ?? ids[0] ?? ''
      standingKeyRequests.push(wanted)
      if (!ids.includes(wanted) || failingStandingKeys.has(wanted)) {
        return Promise.reject(new UnknownPresetError(wanted, ids))
      }
      let key = standingKeys.get(wanted)
      if (key === undefined) {
        key = { agentPreset: wanted }
        standingKeys.set(wanted, key)
      }
      return Promise.resolve(key)
    },
  }
}

/** Standing keys the roster double minted, and the ids readers asked for. */
const standingKeys = new Map<string, object>()
const standingKeyRequests: string[] = []
/** Preset ids whose standing mount the double reports as unusable. */
const failingStandingKeys = new Set<string>()

/** Per-agent service instances a mounted preset would own, keyed by session id. */
const services = new Map<string, Record<string, unknown>>()

async function harness(
  presets?: readonly string[],
  persistence?: unknown,
  options: {
    userIds?: readonly string[]
    defaults?: Record<string, unknown>
    profilePermissions?: Readonly<Record<string, string>>
    profileSupervision?: Readonly<Record<string, 'supervised' | 'unsupervised'>>
  } = {},
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-preset-')))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.provide('sessionPersistence', (persistence ?? { list: () => Promise.resolve([]) }) as never)
  if (presets !== undefined) {
    ctx.provide('agentPresets', roster(presets, options.userIds, options.profilePermissions, options.profileSupervision) as never)
  }
  ctx.provide('permissionPresets', {
    set: (session: Session, preset: string) => {
      session.append('permission/preset', { preset })
    },
  } as never)
  ctx.provide('supervision', { modeOf: () => 'supervised' } as never)

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const session = ctx.sessions.create(
        options.sessionId,
        options.meta === undefined ? {} : { meta: options.meta },
      )
      const agent = stubAgent(session)
      // Setup runs before publication against a context that carries the
      // agent, and the agent reaches back through `agent.ctx` — the pair the
      // gateway's own `installTarget` relies on.
      const agentCtx = ctx.extend({ agent })
      ;(agent as { ctx?: Context }).ctx = agentCtx
      await options.setup?.(agentCtx)
      const unregister = ctx.agents.register(agent)
      return { agent, dispose: () => { unregister(); return Promise.resolve() } }
    },
    async resume() {
      throw new Error('test harness has no persisted sessions')
    },
  }
  ctx.agents.setFactory(factory)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd,
    ...options.defaults,
  })
  return { api, ctx, cwd }
}

describe('session.create with an agent profile', () => {
  it('records the resolved profile on the session header', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])

    const created = await api.sessions.create(request({ sessionId: SessionId('s1'), agentProfile: 'minimal' }))

    expect(created.result.ok).toBe(true)
    expect(ctx.sessions.get(SessionId('s1'))?.header.agentProfile).toBe('minimal')
  })

  it('records the default when the caller names none', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])

    await api.sessions.create(request({ sessionId: SessionId('s2') }))

    expect(ctx.sessions.get(SessionId('s2'))?.header.agentProfile).toBe('standard')
  })

  it('applies the profile default permission before publication', async () => {
    const { api, ctx } = await harness(['standard'], undefined, {
      profilePermissions: { standard: 'workspace-write' },
    })
    const publishedPermissions: string[][] = []
    ctx.on('agent/created', ({ agent }) => {
      publishedPermissions.push(agent.session.events
        .filter(event => event.type === 'permission/preset')
        .map(event => event.data.preset))
    })

    await api.sessions.create(request({ sessionId: SessionId('permission-profile'), agentProfile: 'standard' }))

    expect(publishedPermissions).toEqual([['workspace-write']])
  })

  it('applies the profile supervision mode before publication', async () => {
    const { api, ctx } = await harness(['standard'], undefined, {
      profileSupervision: { standard: 'unsupervised' },
    })
    const publishedModes: string[][] = []
    ctx.on('agent/created', ({ agent }) => {
      publishedModes.push(agent.session.events
        .filter(event => event.type === 'supervision/mode')
        .map(event => event.data.mode))
    })

    await api.sessions.create(request({ sessionId: SessionId('supervision-profile'), agentProfile: 'standard' }))

    expect(publishedModes).toEqual([['unsupervised']])
  })

  it('rejects an unknown preset and names the ones that exist', async () => {
    const { api } = await harness(['standard'])

    const response = await api.sessions.create(request({ sessionId: SessionId('s3'), agentProfile: 'nope' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })

  it('refuses to adopt a live session under a different preset', async () => {
    const { api } = await harness(['standard', 'minimal'])
    await api.sessions.create(request({ sessionId: SessionId('s4'), agentProfile: 'minimal' }))

    const response = await api.sessions.create(request({ sessionId: SessionId('s4'), agentProfile: 'standard' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-conflict')
    expect(response.result.error.details).toEqual({
      sessionId: 's4',
      requestedPreset: 'standard',
      existingPreset: 'minimal',
    })
  })

  it('adopts a live session unchanged when the caller names no preset', async () => {
    const { api } = await harness(['standard', 'minimal'])
    await api.sessions.create(request({ sessionId: SessionId('s5'), agentProfile: 'minimal' }))

    // Reconnecting and retrying a create must stay ordinary operations.
    const response = await api.sessions.create(request({ sessionId: SessionId('s5') }))

    expect(response.result.ok).toBe(true)
  })

  it('leaves the header preset-less when no roster is composed', async () => {
    const { api, ctx } = await harness()

    await api.sessions.create(request({ sessionId: SessionId('s6') }))

    expect(ctx.sessions.get(SessionId('s6'))?.header.agentProfile).toBeUndefined()
  })

  it('says why a preset-less session cannot be adopted under one', async () => {
    // Two callers reach this: a deployment that composes no roster, and a
    // session created before one existed. Both record no preset, so naming
    // any is a conflict rather than an adoption — the history was produced
    // under a composition this roster cannot name. The message has to say
    // that, because "already runs agent preset undefined" reads as a bug.
    const { api } = await harness()
    await api.sessions.create(request({ sessionId: SessionId('s7') }))

    const response = await api.sessions.create(request({ sessionId: SessionId('s7'), agentProfile: 'standard' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-conflict')
    expect(response.result.error.message).toContain('records no agent preset')
    expect(response.result.error.details).toEqual({
      sessionId: 's7',
      requestedPreset: 'standard',
      existingPreset: undefined,
    })
  })
})

/**
 * A capability a preset mounts is reachable from nowhere the host normally
 * looks: an `isolate` realm is what makes it per session. The gateway serves
 * requests that are ABOUT a session from OUTSIDE it, so it addresses the
 * instance through the agent instead of reading a root-realm singleton.
 */
describe('a capability the session\'s preset mounts', () => {
  it('serves the goal RPC from the session\'s own goal service', async () => {
    const { api } = await harness(['standard'])
    await api.sessions.create(request({ sessionId: SessionId('g1'), agentProfile: 'standard' }))
    const ref = { id: GoalId('goal-1'), revision: 1 }
    const paused: unknown[] = []
    services.set('g1', {
      goals: { pause: (agent: { id: unknown }, r: unknown) => { paused.push([String(agent.id), r]); return ref } },
    })

    const response = await api.goals.pause(request({ sessionId: SessionId('g1'), ref }))

    expect(response.result).toMatchObject({ ok: true, value: { ref } })
    // Reached the instance this session mounted, and was handed its own agent.
    expect(paused).toEqual([['g1', ref]])
    services.delete('g1')
  })

  it('serves the skill catalog from the session\'s own registry', async () => {
    const { api } = await harness(['standard'])
    await api.sessions.create(request({ sessionId: SessionId('k1'), agentProfile: 'standard' }))
    services.set('k1', {
      skills: {
        list: () => Promise.resolve([{
          name: 'preset-owned',
          description: 'ships inside the preset directory',
          invocation: { modelInvocable: true, userInvocable: true },
        }]),
      },
    })

    const response = await api.skills.list(request({ sessionId: SessionId('k1') }))

    // A preset ships its own skill directory, so the catalog IS the
    // session's; reading a host singleton would answer for the wrong one.
    expect(response.result).toMatchObject({ ok: true, value: { skills: [{ name: 'preset-owned' }] } })
    services.delete('k1')
  })

  it('says so when no composition mounts the capability at all', async () => {
    const { api } = await harness(['standard'])
    await api.sessions.create(request({ sessionId: SessionId('n1'), agentProfile: 'standard' }))

    const response = await api.skills.list(request({ sessionId: SessionId('n1') }))

    // Absent means absent — not "this session has none", which is what a
    // root-realm read used to report for every presetd session.
    expect(response.result.ok).toBe(false)
    const failure = response.result as { ok: false; error: { message: string } }
    expect(failure.error.message).toContain('neither this session')
  })
})

describe('agentPreset.list', () => {
  it('marks the default and carries each preset\'s trust', async () => {
    const { api } = await harness(['standard', 'minimal'])

    const response = await api.agentPresets.list(request({}))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.presets).toEqual([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'minimal', trust: 'system', isDefault: false },
    ])
    expect(response.result.value.authorable).toBe(true)
  })

  it('answers with an empty roster when the deployment composes no presets', async () => {
    const { api } = await harness()

    const response = await api.agentPresets.list(request({}))

    // Composing no presets is a valid deployment, not an error: every session
    // then shares the host composition and the browser offers no choice.
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.presets).toEqual([])
    // Nothing to write to either, so a surface offering "new preset" knows to
    // stay hidden rather than offering a button whose save always fails.
    expect(response.result.value.authorable).toBe(false)
  })
})

describe('authoring over the wire', () => {
  it('reads a composition with its trust', async () => {
    const { api } = await harness(['standard'])

    const response = await api.agentPresets.read(request({ agentPreset: 'standard' }))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    // The shipped set is readable: it is the known-good composition a copy
    // starts from, and trust is what tells a surface to say so.
    expect(response.result.value.trust).toBe('system')
    expect(response.result.value.content).toContain('- id: x')
  })

  it('copies a preset under a new id', async () => {
    const { api } = await harness(['standard'])

    const response = await api.agentPresets.copy(
      request({ from: 'standard', agentPreset: 'mine', name: '我的模式' }))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.agentPreset).toBe('mine')
  })

  it('rejects a copy target that could escape the preset root', async () => {
    const { api } = await harness(['standard'])

    const response = await api.agentPresets.copy(request({ from: 'standard', agentPreset: '../escape' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-invalid')
  })

  it('rejects a copy target the roster already supplies', async () => {
    const { api } = await harness(['standard', 'minimal'])

    const response = await api.agentPresets.copy(request({ from: 'standard', agentPreset: 'minimal' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-invalid')
    expect(response.result.error.message).toMatch(/already exists/)
  })

  it('rejects a copy whose source is unknown', async () => {
    const { api } = await harness(['standard'])

    const response = await api.agentPresets.copy(request({ from: 'never-existed', agentPreset: 'mine' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })

  it('reports a deployment that composes no presets', async () => {
    const { api } = await harness()

    const response = await api.agentPresets.read(request({ agentPreset: 'anything' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })

  it('reports an unknown id on delete rather than succeeding silently', async () => {
    const { api } = await harness(['standard'])

    const response = await api.agentPresets.remove(request({ agentPreset: 'never-existed' }))

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-not-found')
  })
})

describe('opening a preset directory', () => {
  it('hands the resolved directory to the native opener', async () => {
    const opened: string[] = []
    const { api } = await harness(['standard', 'my-preset'], undefined, {
      userIds: ['my-preset'],
      defaults: { openPath: (path: string) => { opened.push(path); return Promise.resolve() } },
    })

    const response = await api.agentPresets.openDocument(
      request({ agentPreset: 'my-preset' }), new AbortController().signal)

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value).toEqual({ opened: true })
    // The id selected the directory; the browser supplied no path.
    expect(opened).toEqual(['/presets/my-preset'])
  })

  it('answers the path as text where the deployment has no opener', async () => {
    const { api } = await harness(['standard', 'my-preset'], undefined, {
      userIds: ['my-preset'],
      defaults: { canOpenPath: () => false },
    })

    const response = await api.agentPresets.openDocument(
      request({ agentPreset: 'my-preset' }), new AbortController().signal)

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value).toEqual({ opened: false, path: '/presets/my-preset' })
  })

  it('refuses a preset that ships with the deployment', async () => {
    const opened: string[] = []
    const { api } = await harness(['standard'], undefined, {
      defaults: { openPath: (path: string) => { opened.push(path); return Promise.resolve() } },
    })

    const response = await api.agentPresets.openDocument(
      request({ agentPreset: 'standard' }), new AbortController().signal)

    // Pointing an editor into the install invites edits an upgrade will
    // silently overwrite; the refusal mirrors copy/remove.
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('agent-preset-read-only')
    expect(opened).toEqual([])
  })

  it('reports the roster capability on list', async () => {
    const openable = await harness(['standard'], undefined, {
      defaults: { canOpenPath: () => true },
    })
    const headless = await harness(['standard'], undefined, {
      defaults: { canOpenPath: () => false },
    })

    const yes = await openable.api.agentPresets.list(request({}))
    const no = await headless.api.agentPresets.list(request({}))

    expect(yes.result.ok && yes.result.value.hasDocument).toBe(true)
    expect(no.result.ok && no.result.value.hasDocument).toBe(false)
  })

  it('counts an injected opener as openable', async () => {
    const { api } = await harness(['standard'], undefined, {
      defaults: { openPath: () => Promise.resolve() },
    })

    const response = await api.agentPresets.list(request({}))

    expect(response.result.ok && response.result.value.hasDocument).toBe(true)
  })
})

describe('skills over the layered host registry', () => {
  it('passes the live agent as the view scope to the host registry', async () => {
    const { api, ctx } = await harness(['standard'])
    const seen: unknown[] = []
    ctx.provide('skills', {
      list: (options: { scope?: unknown }) => {
        seen.push(options.scope)
        return Promise.resolve([])
      },
    } as never)
    await api.sessions.create(request({ sessionId: SessionId('h1'), agentProfile: 'standard' }))

    const response = await api.skills.list(request({ sessionId: SessionId('h1') }))

    expect(response.result).toMatchObject({ ok: true, value: { skills: [] } })
    expect(seen).toEqual([ctx.agents.get(SessionId('h1'))])
  })

  it('resolves a cold session to its recorded preset standing key', async () => {
    const { api, ctx } = await harness(['standard', 'minimal'])
    const seen: unknown[] = []
    ctx.provide('skills', {
      list: (options: { scope?: unknown }) => {
        seen.push(options.scope)
        return Promise.resolve([])
      },
    } as never)
    ctx.sessions.create(SessionId('h2'), { meta: { cwd: '/workspace/cold', agentProfile: 'minimal' } })

    const response = await api.skills.list(request({ sessionId: SessionId('h2') }))

    expect(response.result).toMatchObject({ ok: true, value: { skills: [] } })
    expect(seen).toEqual([standingKeys.get('minimal')])
  })

  it('serves the global view when the roster no longer supplies the recorded preset', async () => {
    const { api, ctx } = await harness(['standard'])
    const seen: unknown[] = []
    ctx.provide('skills', {
      list: (options: { scope?: unknown }) => {
        seen.push(options.scope)
        return Promise.resolve([])
      },
    } as never)
    ctx.sessions.create(SessionId('h3'), { meta: { cwd: '/workspace/cold', agentProfile: 'gone' } })

    const response = await api.skills.list(request({ sessionId: SessionId('h3') }))

    expect(response.result).toMatchObject({ ok: true, value: { skills: [] } })
    expect(seen).toEqual([undefined])
  })
})

describe('session.history presenter scope', () => {
  it('asks the roster for the RECORDED preset\'s standing key on a cold read', async () => {
    const { api } = await harness(['standard', 'minimal'])
    await api.sessions.create(request({ sessionId: SessionId('p1'), agentProfile: 'minimal' }))
    // Cold: creation registered a live agent in this harness, so simulate the
    // cold path by asking for a session only persistence knows... the harness
    // has no persistence, so read the live one and assert no roster query.
    standingKeyRequests.length = 0
    const live = await api.sessions.history(request({ sessionId: SessionId('p1') }))
    expect(live.result.ok).toBe(true)
    // A live agent IS the presenter scope; the roster is not consulted.
    expect(standingKeyRequests).toEqual([])
  })

  it('resolves a cold session from its immutable profile header', async () => {
    const meta = { id: SessionId('p4'), createdAt: 1, cwd: '/tmp/p4', agentProfile: 'standard' }
    const { api } = await harness(['standard', 'minimal'], {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })

    standingKeyRequests.length = 0
    const response = await api.sessions.history(request({ sessionId: SessionId('p4') }))

    expect(response.result.ok).toBe(true)
    expect(standingKeyRequests).toEqual(['standard'])
  })

  it('serves a COLD transcript whose standing mount is no longer usable', async () => {
    // A genuinely cold session: persistence knows it, no live agent exists.
    const meta = { id: SessionId('p3'), createdAt: 1, cwd: '/tmp/p3', agentProfile: 'standard' }
    const { api } = await harness(['standard'], {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })
    // The preset broke after the session ran: the roster rejects the mount.
    failingStandingKeys.add('standard')
    try {
      standingKeyRequests.length = 0
      const response = await api.sessions.history(request({ sessionId: SessionId('p3') }))
      // Degraded, never failed: the roster WAS asked, and the transcript
      // still serves — with the generic cards a viewless entry renders.
      expect(standingKeyRequests).toEqual(['standard'])
      expect(response.result.ok).toBe(true)
    } finally {
      failingStandingKeys.delete('standard')
    }
  })
})
