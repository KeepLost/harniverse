/**
 * Child Profile management tools: grant fallback binding, full specification
 * define, grant projection, and caller/argument validation.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as mock from './scripted-provider.ts'
import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function profileSetup(config: Partial<tool.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  await mock.mountScriptedProvider(ctx, { name: 'mock' })
  const fiber = ctx.plugin(tool, {
    provider: 'mock',
    enableChildProfileDefine: true,
    enableChildProfileList: true,
    ...config,
  })
  await fiber
  return { ctx, fiber }
}

function parentAgent(
  id: string,
  over: { options?: object; cwd?: string } = {},
): Agent {
  return {
    id: SessionId(id),
    options: over.options ?? {},
    session: {
      header: {
        version: 0,
        id: SessionId(id),
        createdAt: 1,
        ...(over.cwd !== undefined ? { cwd: over.cwd } : {}),
      },
    },
  } as unknown as Agent
}

let calls = 0
function callTool(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`profile-${++calls}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('child_profile_define', () => {
  it('resolves a complete specification against the parent grant', async () => {
    const { ctx } = await profileSetup()
    const root = mkdtempSync(join(tmpdir(), 'dsh-child-profile-'))
    roots.push(root)
    const parent = parentAgent('full-spec-parent', { cwd: root })
    ctx.subagents.registerChildModelRoute('safe', { provider: 'mock', model: 'safe-model' })
    ctx.subagents.registerChildProfileGrant(parent, {
      harnessIds: ['mock'],
      modelRouteIds: ['safe'],
      tools: ['read', 'write'],
      skills: ['skill-a'],
      mcpServerIds: ['mcp-a'],
      childProfileIds: ['kid-a'],
      workspaceRoot: root,
      parentWorkspaceCwd: root,
      maxDepth: 3,
      maxTokens: 500,
    })

    const defined = await callTool(ctx, 'child_profile_define', {
      child_profile_id: 'full',
      harness_id: 'mock',
      model_route_id: 'safe',
      tools: ['read'],
      skills: ['skill-a'],
      mcp_server_ids: ['mcp-a'],
      child_profile_ids: ['kid-a'],
      workspace_cwd: 'sub',
      max_depth: 2,
      max_tokens: 100,
      model_route_priority: 1,
      scheduler_priority: 2,
      supervision_mode: 'supervised',
    }, parent)

    expect(defined.isError, text(defined)).toBe(false)
    expect(defined.isError ? undefined : defined.value).toMatchObject({
      profileId: 'full',
      revision: 1,
      harnessId: 'mock',
      modelRouteId: 'safe',
      tools: ['read'],
      skills: ['skill-a'],
      mcpServerIds: ['mcp-a'],
      childProfileIds: ['kid-a'],
      workspaceCwd: join(root, 'sub'),
      maxDepth: 2,
      maxTokens: 100,
      modelRoutePriority: 1,
      schedulerPriority: 2,
      supervisionMode: 'supervised',
    })
    const digest = (defined.isError ? undefined : defined.value) as { digest: string }
    expect(digest.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a supervision mode outside the fixed vocabulary', async () => {
    const { ctx } = await profileSetup()
    const parent = parentAgent('supervision-parent', { options: { provider: 'mock', model: 'm' }, cwd: '/repo' })

    const result = await callTool(ctx, 'child_profile_define', {
      child_profile_id: 'bad',
      supervision_mode: 'bogus',
    }, parent)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('supervision_mode must be')
  })

  it('falls back to the configured agent options when the parent route is unresolved', async () => {
    const { ctx } = await profileSetup({ agentOptions: { provider: 'mock', model: 'fallback-model' } })
    const parent = parentAgent('fallback-parent')

    const defined = await callTool(ctx, 'child_profile_define', {
      child_profile_id: 'via-config',
    }, parent)
    expect(defined.isError, text(defined)).toBe(false)
    expect(defined.isError ? undefined : defined.value).toMatchObject({
      modelRouteId: 'parent:mock:fallback-model',
      harnessId: 'mock',
    })

    const listed = await callTool(ctx, 'child_profile_list', {}, parent)
    expect(listed.isError, text(listed)).toBe(false)
    const grant = (listed.isError ? undefined : listed.value) as {
      grant: { workspaceRoot: string; modelRouteIds: string[] }
    }
    expect(grant.grant.workspaceRoot).toBe(process.cwd())
    expect(grant.grant.modelRouteIds).toContain('parent:mock:fallback-model')
  })

  it('rejects a parent with no resolved route anywhere', async () => {
    const { ctx } = await profileSetup()
    const parent = parentAgent('routeless-parent', { options: {} })

    const result = await callTool(ctx, 'child_profile_define', {
      child_profile_id: 'any',
    }, parent)

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a parent with a resolved provider and model route')
  })

  it('binds no depth cap when apply() is invoked directly with provider-managed depth', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    await mock.mountScriptedProvider(ctx, { name: 'mock' })
    tool.apply(ctx, { provider: 'mock', enableChildProfileDefine: true, enableChildProfileList: true, maxDepth: 'provider-managed' })

    const parent = parentAgent('capless-parent', { options: { provider: 'mock', model: 'm' }, cwd: '/repo' })
    const listed = await callTool(ctx, 'child_profile_list', {}, parent)
    expect(listed.isError, text(listed)).toBe(false)
    const grant = (listed.isError ? undefined : listed.value) as { grant: Record<string, unknown> }
    expect(grant.grant).not.toHaveProperty('maxDepth')
  })

  it('fails loud without a calling agent and is concurrency-safe', async () => {
    const { ctx } = await profileSetup()
    const result = await callTool(ctx, 'child_profile_define', { child_profile_id: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('child_profile_define requires a calling agent')
    expect(ctx.tools.executionMode({
      signal: testToolSignal,
      callId: CallId('profile-define-mode'),
      name: 'child_profile_define',
      arguments: { child_profile_id: 'x' },
    })).toEqual({ kind: 'parallel' })
  })
})

describe('child_profile_list', () => {
  it('removes both profile tools when the plugin fiber is disposed', async () => {
    const { ctx, fiber } = await profileSetup()
    expect(ctx.tools.schemas().some(schema => schema.name === 'child_profile_define')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'child_profile_list')).toBe(true)

    await fiber.dispose()

    expect(ctx.tools.schemas().some(schema => schema.name === 'child_profile_define')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'child_profile_list')).toBe(false)
  })

  it('projects a grant that carries maxTokens but no depth cap', async () => {
    const { ctx } = await profileSetup()
    const parent = parentAgent('token-grant-parent', { cwd: '/repo' })
    ctx.subagents.registerChildModelRoute('safe', { provider: 'mock', model: 'safe-model' })
    ctx.subagents.registerChildProfileGrant(parent, {
      harnessIds: ['mock'],
      modelRouteIds: ['safe'],
      tools: [],
      skills: [],
      mcpServerIds: [],
      childProfileIds: [],
      workspaceRoot: '/repo',
      parentWorkspaceCwd: '/repo',
      maxTokens: 100,
    })

    const listed = await callTool(ctx, 'child_profile_list', {}, parent)

    expect(listed.isError, text(listed)).toBe(false)
    const value = (listed.isError ? undefined : listed.value) as { grant: Record<string, unknown> }
    expect(value.grant).toMatchObject({ maxTokens: 100 })
    expect(value.grant).not.toHaveProperty('maxDepth')
  })

  it('fails loud without a calling agent and is concurrency-safe', async () => {
    const { ctx } = await profileSetup()
    const result = await callTool(ctx, 'child_profile_list', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('child_profile_list requires a calling agent')
    expect(ctx.tools.executionMode({
      signal: testToolSignal,
      callId: CallId('profile-list-mode'),
      name: 'child_profile_list',
      arguments: {},
    })).toEqual({ kind: 'parallel' })
  })
})

describe('delegation by child_profile_id', () => {
  it('rejects an id that names no parent-private profile', async () => {
    const { ctx } = await profileSetup()
    const result = await callTool(ctx, 'subagent', {
      description: 'profiled task',
      prompt: 'use a missing profile',
      child_profile_id: 'missing',
    }, parentAgent('no-profile-parent'))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no parent-private child profile named "missing"')
  })
})
