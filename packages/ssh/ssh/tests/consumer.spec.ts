/** Consumer registration over a captured world: tools, resources, skills, hooks, and disconnect revocation. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/consumer.ts'
import { describeExecutionWorld } from '../src/world.ts'

const execution = (name: string): ToolExecution => ({
  callId: 'call-1', rootCallId: 'call-1', token: 0, name, arguments: {}, signal: new AbortController().signal,
}) as unknown as ToolExecution

const result = {} as unknown as ToolExecutionResult

interface ToolRecord {
  name: string
  description: string
  execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>
  output: { render: (args: unknown, value: unknown) => unknown[] }
}

interface ResourceSpec {
  request: (request: { method: string; uri?: string }, exec: { signal: AbortSignal }) => Promise<unknown>
}

interface Mount {
  ctx: Context
  controller: AbortController
  fiber?: Fiber
  prompts: { name: string; text: string }[]
  disposedPrompts: string[]
  tools: ToolRecord[]
  disposedTools: string[]
  resources: { server: string; spec: ResourceSpec }[]
  disposedResources: string[]
  skills: { name: string; provider: string }[]
  disposedSkills: string[]
  requests: { method: string; params: unknown }[]
  script: (method: string, params: unknown) => unknown
}

const world = describeExecutionWorld('/remote/work', 'machine-4', { id: 'ssh', revision: 'profile-9', mcp: {}, skills: [], hooks: [] }, {
  mcp: [
    { serverName: 'remote', selected: true, instructions: 'handle with care', tools: [
      { name: 'mcp__remote__echo', rawName: 'echo', description: 'echo tool', inputSchema: { type: 'object' } },
    ], resources: [{ uri: 'fixture://a', name: 'a' }], templates: [] },
    { serverName: 'quiet', selected: true, instructions: '', tools: [], resources: [], templates: [] },
    { serverName: 'excluded', selected: false, instructions: 'secret', tools: [], resources: [], templates: [] },
  ],
  skills: [
    { name: 'remote-skill', description: 'Remote skill', path: '/skills/remote', selected: true },
    { name: 'idle', description: 'Idle skill', path: '/skills/idle', selected: false },
  ],
  hooks: [{ id: 'denier', event: 'pre-tool', selected: true }],
})

const mount = (script: Mount['script'], overrides: { ssh?: unknown; tools?: unknown } = {}): Mount => {
  const ctx = new Context()
  const controller = new AbortController()
  const state: Mount = {
    ctx, controller,
    prompts: [], disposedPrompts: [],
    tools: [], disposedTools: [],
    resources: [], disposedResources: [],
    skills: [], disposedSkills: [],
    requests: [], script,
  }
  ctx.provide('ssh', overrides.ssh ?? {
    describeWorld: async () => world,
    request: async <T>(method: string, params: unknown, schema: { parse: (value: unknown) => T }): Promise<T> => {
      state.requests.push({ method, params })
      return schema.parse(await script(method, params))
    },
    signal: controller.signal,
  } as never)
  ctx.provide('systemPrompt', {
    context: (entry: { name: string; text: string }) => {
      state.prompts.push(entry)
      return () => { state.disposedPrompts.push(entry.name) }
    },
  } as never)
  if (overrides.tools === undefined) ctx.provide('tools', { register: (definition: Mount['tools'][number]) => { state.tools.push(definition); return () => { state.disposedTools.push(definition.name) } } } as never)
  else ctx.provide('tools', overrides.tools)
  ctx.provide('mcpResources', { register: (server: string, spec: Mount['resources'][number]['spec']) => { state.resources.push({ server, spec }); return () => { state.disposedResources.push(server) } } } as never)
  ctx.provide('skills', { register: (definition: Mount['skills'][number]) => { state.skills.push(definition); return () => { state.disposedSkills.push(definition.name) } } } as never)
  return state
}

const skillBody = { name: 'remote-skill', description: 'Remote skill', content: 'machine body', source: 'custom', provider: 'machine' }

describe('SSH profile consumer', () => {
  it('registers the captured generation and revokes it on disconnect', async () => {
    let toolCalls = 0
    const state = mount(async (method, params) => {
      if (method === 'machine.skill') return skillBody
      if (method === 'machine.hook') return null
      if ((params as { method?: string }).method !== 'tools/call') return { content: [] }
      toolCalls += 1
      if (toolCalls === 1) return { content: [{ type: 'text', text: 'machine tool' }] }
      return { isError: true, content: [{ type: 'text', text: 'denied by server' }] }
    })
    const fiber = state.ctx.plugin(() => apply(state.ctx))
    await fiber
    void fiber
    try {
      expect(state.prompts.map(prompt => prompt.name)).toEqual(['ssh-execution-world', 'ssh-mcp:remote'])
      expect(state.prompts[0]?.text).toContain('Profile: ssh@profile-9')
      expect(state.tools.map(tool => tool.name)).toEqual(['mcp__remote__echo'])
      expect(state.resources.map(resource => resource.server)).toEqual(['remote', 'quiet'])
      expect(state.skills).toEqual([{ ...skillBody, provider: 'ssh' }])

      const tool = state.tools[0]!
      expect(await tool.execute({ value: 1 }, { signal: new AbortController().signal })).toMatchObject({ content: [{ text: 'machine tool' }] })
      expect(state.requests.at(-1)).toMatchObject({ method: 'machine.mcp', params: { server: 'remote', method: 'tools/call', name: 'mcp__remote__echo', arguments: { value: 1 } } })
      expect(tool.output.render({}, { any: true })).toEqual([{ type: 'text', text: JSON.stringify({ any: true }) }])
      await expect(tool.execute({}, { signal: new AbortController().signal })).rejects.toThrow('isError')

      expect(await state.resources[0]!.spec.request({ method: 'resources/list' }, { signal: new AbortController().signal })).toMatchObject({ content: [] })
      expect(await state.resources[0]!.spec.request({ method: 'resources/read', uri: 'fixture://a' }, { signal: new AbortController().signal })).toMatchObject({ content: [] })
      expect(state.requests.at(-2)?.params).not.toHaveProperty('uri')
      expect(state.requests.at(-1)?.params).toMatchObject({ method: 'resources/read', uri: 'fixture://a' })

      expect(await state.ctx.waterfall('tools/pre-execute', execution('tool'), async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
      expect(state.requests.at(-1)).toMatchObject({ method: 'machine.hook', params: { event: 'pre-tool', payload: { name: 'tool' } } })
      expect(await state.ctx.waterfall('tools/post-execute', execution('tool'), result, async () => ({ kind: 'accept' }))).toEqual({ kind: 'accept' })

      state.controller.abort(new Error('connection lost'))
      expect(state.disposedPrompts).toEqual(['ssh-mcp:remote', 'ssh-execution-world'])
      expect(state.disposedTools).toEqual(['mcp__remote__echo'])
      expect(state.disposedResources).toEqual(['quiet', 'remote'])
      expect(state.disposedSkills).toEqual(['remote-skill'])
    } finally { await state.ctx.fiber.dispose() }
  })

  it('releases partial registrations when apply fails and when the connection died mid-apply', async () => {
    const failing = mount(async (method) => {
      if (method === 'machine.skill') return skillBody
      return null
    }, { tools: { register: () => { throw new Error('registry full') } } })
    await expect(failing.ctx.plugin(() => apply(failing.ctx))).rejects.toThrow('registry full')
    expect(failing.disposedPrompts).toContain('ssh-execution-world')

    const dead = new AbortController()
    const aborted = mount(async (method) => {
      if (method === 'machine.skill') return skillBody
      return null
    }, { ssh: {
      describeWorld: async () => { dead.abort(new Error('died')); return world },
      request: async () => null,
      signal: dead.signal,
    } })
    await expect(aborted.ctx.plugin(() => apply(aborted.ctx))).rejects.toThrow()
    expect(aborted.disposedPrompts).toContain('ssh-execution-world')

    const midSkill = mount(async () => { midSkill.controller.abort(new Error('died')); return skillBody })
    await expect(midSkill.ctx.plugin(() => apply(midSkill.ctx))).rejects.toThrow()
    expect(midSkill.disposedPrompts).toContain('ssh-execution-world')
  })

  it('skips hook listeners when no hook is captured', async () => {
    const quiet = describeExecutionWorld('/remote/work', 'machine-5',
      { id: 'ssh', revision: 'profile-9', mcp: {}, skills: [], hooks: [] },
      { mcp: [], skills: [], hooks: [{ id: 'denier', event: 'pre-tool', selected: false }] })
    const quietControl = new AbortController()
    const state = mount(async () => null, {
      ssh: { describeWorld: async () => quiet, request: async () => null, signal: quietControl.signal },
    })
    const fiber = state.ctx.plugin(() => apply(state.ctx))
    await fiber
    void fiber
    try { await state.ctx.waterfall('tools/pre-execute', execution('tool'), async () => ({ kind: 'allow' })) }
    finally { await state.ctx.fiber.dispose() }
  })

  it('parses skill bodies strictly before registering', async () => {
    const state = mount(async () => ({ name: 'remote-skill' }))
    await expect(state.ctx.plugin(() => apply(state.ctx))).rejects.toThrow()
    expect(state.skills).toEqual([])
  })
})
