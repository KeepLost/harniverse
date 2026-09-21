import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Skills from '@deepseek-ai/dsh-skill'
import { mcpResourceMemberId, mcpResourceTemplateMemberId } from '@deepseek-ai/dsh-mcp-client'
import { describe, expect, it } from 'vitest'
import { MachineRuntime } from '../src/machine.ts'

const server = `
import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
 const message = JSON.parse(line); if (message.id === undefined) continue;
 let result = {};
 if (message.method === 'initialize') result = {protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{},resources:{}},instructions:'machine instructions'};
 if (message.method === 'tools/list') result = {tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{}}}]};
 if (message.method === 'resources/list') result = {resources:[{uri:'fixture://allowed',name:'allowed'},{uri:'fixture://denied',name:'denied'}]};
 if (message.method === 'resources/templates/list') result = {resourceTemplates:[{uriTemplate:'fixture://items/{id}',name:'items'}]};
 if (message.method === 'resources/read') result = {contents:[{uri:message.params.uri,text:'machine resource'}]};
 if (message.method === 'tools/call') result = {content:[{type:'text',text:'machine tool'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
}
`

describe('machine-owned configuration and captured Profile', () => {
  it('enforces resource/template/member exclusions through direct execution and detaches the Profile input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w10-mcp-'))
    const fixture = join(root, 'mcp.mjs')
    await writeFile(fixture, server)
    const ctx = new Context()
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(Skills)
    const profile = { id: 'ssh', revision: 'captured-1', mcp: { remote: { members: [mcpResourceMemberId('remote', 'fixture://allowed'), mcpResourceTemplateMemberId('remote', 'fixture://items/{id}')] } }, skills: [], hooks: [] }
    const machine = new MachineRuntime(ctx, { revision: 'machine-9', skillDirectories: [], hooks: [], mcp: [
      { serverName: 'remote', transport: 'stdio', command: process.execPath, args: [fixture], cwd: root, env: {} },
      { serverName: 'excluded', transport: 'stdio', command: '/must-not-execute', args: [], cwd: root, env: {} },
    ] }, profile)
    const signal = AbortSignal.timeout(10_000)
    try {
      profile.mcp.remote.members.push(mcpResourceMemberId('remote', 'fixture://denied'))
      await machine.discover(signal, root)
      expect(machine.inventory.mcp[0]?.tools).toEqual([])
      expect(machine.inventory.mcp[0]?.instructions).toBe('machine instructions')
      expect(machine.inventory.mcp[1]).toMatchObject({ selected: false, instructions: '', resources: [] })
      expect(await machine.request({ server: 'remote', method: 'resources/list' }, signal)).toMatchObject({ resources: [{ uri: 'fixture://allowed' }] })
      await expect(machine.request({ server: 'remote', method: 'resources/read', uri: 'fixture://denied' }, signal)).rejects.toThrow('excluded')
      await expect(machine.request({ server: 'excluded', method: 'resources/list' }, signal)).rejects.toThrow('excluded')
      await expect(machine.request({ server: 'remote', method: 'tools/call', name: 'mcp__remote__echo' }, signal)).rejects.toThrow('excluded')
      expect(await machine.request({ server: 'remote', method: 'resources/read', uri: 'fixture://items/42' }, signal)).toMatchObject({ contents: [{ text: 'machine resource' }] })
    } finally { await machine.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('runs only selected machine hooks and loads only selected Skill bodies', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(Skills)
    ctx.skills.register({ name: 'remote-skill', description: 'Remote skill', source: 'custom', content: 'machine body' })
    const machine = new MachineRuntime(ctx, { revision: '1', mcp: [], skillDirectories: [], hooks: [
      { id: 'denier', event: 'pre-tool', argv: ['/bin/sh', '-c', 'exit 7'], cwd: tmpdir(), timeoutMs: 1000 },
      { id: 'excluded', event: 'post-tool', argv: ['/must-not-execute'], cwd: tmpdir(), timeoutMs: 1000 },
    ] }, { id: 'ssh', revision: '2', mcp: {}, skills: ['remote-skill'], hooks: ['denier'] })
    try {
      await machine.discover(AbortSignal.timeout(5000), tmpdir())
      expect(machine.skill('remote-skill')).toMatchObject({ content: 'machine body' })
      expect(() => machine.skill('excluded')).toThrow('excluded')
      await expect(machine.hook({ event: 'pre-tool', payload: {} }, AbortSignal.timeout(5000))).rejects.toThrow('denied')
      await machine.hook({ event: 'post-tool', payload: {} }, AbortSignal.timeout(5000))
    } finally { await machine.close(); await ctx.fiber.dispose() }
  })
})
