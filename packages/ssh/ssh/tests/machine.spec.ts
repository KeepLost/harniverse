/** Machine-owned MCP/Skill/Hook discovery and gating: manifest bounds, member visibility, pagination limits, and cleanup joins. */
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Skills from '@deepseek-ai/dsh-skill'
import { mcpResourceMemberId, mcpResourceTemplateMemberId } from '@deepseek-ai/dsh-mcp-client'
import { describe, expect, it } from 'vitest'
import { loadMachineConfig, MachineRuntime } from '../src/machine.ts'

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

/** Build an stdio MCP fixture file answering each request method through a table. */
const fixtureServer = (handlers: string): string => `
import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
 const message = JSON.parse(line); if (message.id === undefined) continue;
 let result;
 ${handlers}
 if (result !== undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
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

  it('fails closed after close and refuses duplicate servers and oversized manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w10-mcp-'))
    const fixture = join(root, 'mcp.mjs')
    await writeFile(fixture, server)
    await writeFile(join(root, 'oversize.json'), 'x'.repeat(1024 * 1024 + 1))
    await writeFile(join(root, 'malformed.json'), '{')
    await expect(loadMachineConfig(join(root, 'oversize.json'))).rejects.toThrow('SSH machine configuration exceeds 1 MiB')
    await expect(loadMachineConfig(join(root, 'malformed.json'))).rejects.toThrow()
    await expect(loadMachineConfig(join(root, 'absent.json'))).rejects.toThrow()

    const ctx = new Context()
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(Skills)
    const duplicate = { revision: '1', mcp: [
      { serverName: 'remote', transport: 'stdio' as const, command: process.execPath, args: [fixture], cwd: root, env: {} },
      { serverName: 'remote', transport: 'stdio' as const, command: process.execPath, args: [fixture], cwd: root, env: {} },
    ], skillDirectories: [], hooks: [] }
    const machine = new MachineRuntime(ctx, duplicate, { id: 'ssh', revision: '1', mcp: { remote: {} }, skills: [], hooks: [] })
    try {
      await expect(machine.discover(AbortSignal.timeout(5000), root)).rejects.toThrow('Duplicate machine MCP server name')
      expect(machine.inventory.mcp).toHaveLength(1)
    } finally { await machine.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }

    const closed = new MachineRuntime(new Context(), { revision: '1', mcp: [], skillDirectories: [], hooks: [] }, { id: 'ssh', revision: '1', mcp: {}, skills: [], hooks: [] })
    await closed.close()
    await expect(closed.request({ server: 'x', method: 'resources/list' }, AbortSignal.timeout(1000))).rejects.toThrow('SSH machine generation is closed')
    expect(() => closed.skill('x')).toThrow('SSH machine generation is closed')
    await expect(closed.hook({ event: 'pre-tool', payload: {} }, AbortSignal.timeout(1000))).rejects.toThrow('SSH machine generation is closed')
  })

  it('exposes visible tools, template listings, hashed public names, and granted calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w10-mcp-'))
    const fixture = join(root, 'mcp.mjs')
    await writeFile(fixture, fixtureServer(`
 if (message.method === 'initialize') result = {protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{},resources:{}},instructions:'machine instructions'};
 if (message.method === 'tools/list') result = {tools:[
   {name:'echo',description:'echo tool',inputSchema:{type:'object'}},
   {name:'bare',inputSchema:{type:'object'}},
   {name:'echo!bang',description:'special',inputSchema:{type:'object'}},
   {name:'${'y'.repeat(70)}',description:'long',inputSchema:{type:'object'}},
 ]};
 if (message.method === 'resources/list') result = {resources:[]};
 if (message.method === 'resources/templates/list') result = {resourceTemplates:[{uriTemplate:'fixture://items/{id}',name:'items'}]};
 if (message.method === 'tools/call') result = {content:[{type:'text',text:'called '+message.params.name}]};
`))
    const ctx = new Context()
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(Skills)
    const profile = { id: 'ssh', revision: 'captured-2', mcp: { remote: {} }, skills: [], hooks: [] }
    const machine = new MachineRuntime(ctx, { revision: 'machine-9', skillDirectories: [], hooks: [], mcp: [
      { serverName: 'remote', transport: 'stdio', command: process.execPath, args: [fixture], cwd: root, env: {} },
    ] }, profile)
    const signal = AbortSignal.timeout(10_000)
    try {
      await machine.discover(signal, root)
      const row = machine.inventory.mcp[0]!
      const hashed = (raw: string): string => `mcp__remote__${raw.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 51) + '_' + createHash('sha256').update(`remote\0${raw}`).digest('hex').slice(0, 12)
      const names = row.tools.map(tool => tool.name)
      expect(names).toContain('mcp__remote__echo')
      expect(names).toContain('mcp__remote__bare')
      expect(names).toContain(hashed('echo!bang'))
      expect(names).toContain(hashed('y'.repeat(70)))
      expect(names.every(name => name.length <= 64)).toBe(true)
      expect(row.tools.find(tool => tool.name === 'mcp__remote__bare')?.description).toBe('')
      expect(await machine.request({ server: 'remote', method: 'resources/templates/list' }, signal)).toMatchObject({ resourceTemplates: [{ uriTemplate: 'fixture://items/{id}' }] })
      expect(await machine.request({ server: 'remote', method: 'tools/call', name: 'mcp__remote__echo' }, signal)).toMatchObject({ content: [{ text: 'called echo' }] })
      expect(await machine.request({ server: 'remote', method: 'tools/call', name: 'mcp__remote__echo', arguments: { value: 1 } }, signal)).toMatchObject({ content: [{ text: 'called echo' }] })
      await expect(machine.request({ server: 'remote', method: 'tools/call', name: 'mcp__remote__missing' }, signal)).rejects.toThrow('MCP tool excluded by captured Profile')
    } finally { await machine.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  }, 20_000)

  it('skips capability-less servers and skips skills whose bodies vanished', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w10-mcp-'))
    const fixture = join(root, 'mcp.mjs')
    await writeFile(fixture, fixtureServer(`
 if (message.method === 'initialize') result = {protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{}};
`))
    const ctx = new Context()
    await ctx.plugin(LocalSubprocess)
    ctx.provide('skills', {
      list: async () => [{ name: 'ghost', description: 'listed but gone' }, { name: 'kept', description: 'kept body' }, { name: 'idle', description: 'not captured' }],
      get: async (name: string) => (name === 'ghost' ? undefined : { name, description: 'body', source: 'custom', content: 'body text' }),
    } as never)
    const machine = new MachineRuntime(ctx, { revision: '1', mcp: [
      { serverName: 'remote', transport: 'stdio', command: process.execPath, args: [fixture], cwd: root, env: {} },
      { serverName: 'http', transport: 'streamable-http', url: 'http://127.0.0.1:1', headers: {} },
    ], skillDirectories: [], hooks: [] }, { id: 'ssh', revision: '1', mcp: { remote: {} }, skills: ['kept'], hooks: [] })
    try {
      await machine.discover(AbortSignal.timeout(10_000), root)
      const unreachable = new MachineRuntime(ctx, { revision: '1', mcp: [
        { serverName: 'http', transport: 'streamable-http', url: 'http://127.0.0.1:1', headers: {} },
      ], skillDirectories: [], hooks: [] }, { id: 'ssh', revision: '1', mcp: { http: {} }, skills: [], hooks: [] })
      await expect(unreachable.discover(AbortSignal.timeout(10_000), root)).rejects.toThrow()
      await unreachable.close()
      const row = machine.inventory.mcp[0]!
      expect(row).toMatchObject({ selected: true, instructions: '', tools: [], resources: [], templates: [] })
      expect(machine.inventory.mcp[1]).toMatchObject({ selected: false })
      expect(machine.inventory.skills.map(skill => skill.name)).toEqual(['kept', 'idle'])
      expect(machine.inventory.skills.find(skill => skill.name === 'kept')?.selected).toBe(true)
      expect(machine.inventory.skills.find(skill => skill.name === 'idle')?.selected).toBe(false)
      expect(machine.skill('kept')).toMatchObject({ content: 'body text' })
      expect(() => machine.skill('idle')).toThrow('Skill excluded by captured Profile')
    } finally { await machine.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('refuses oversized instructions and degenerate pagination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w10-mcp-'))
    const loud = join(root, 'loud.mjs')
    await writeFile(loud, fixtureServer(`
 if (message.method === 'initialize') result = {protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}},instructions:'${'x'.repeat(32769)}'};
 if (message.method === 'tools/list') result = {tools:[]};
`))
    const looping = join(root, 'looping.mjs')
    await writeFile(looping, fixtureServer(`
 if (message.method === 'initialize') result = {protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}};
 if (message.method === 'tools/list') result = {tools:[{name:'echo',description:'echo',inputSchema:{type:'object'}}],nextCursor:'again'};
`))
    const growing = join(root, 'growing.mjs')
    await writeFile(growing, fixtureServer(`
 if (message.method === 'initialize') result = {protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}};
 if (message.method === 'tools/list') result = {tools:[{name:'echo',description:'echo',inputSchema:{type:'object'}}],nextCursor:(message.params?.cursor ?? 'c0')+'-n'};
`))
    const crowded = join(root, 'crowded.mjs')
    await writeFile(crowded, fixtureServer(`
 if (message.method === 'initialize') result = {protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}};
 if (message.method === 'tools/list') result = {tools:Array.from({length:1025},(_,i)=>({name:'t'+i,description:'tool',inputSchema:{type:'object'}}))};
`))
    const ctx = new Context()
    await ctx.plugin(LocalSubprocess)
    for (const [fixture, message] of [[loud, 'SSH MCP instructions exceed 32 KiB'], [looping, 'MCP repeated pagination cursor'], [growing, 'MCP pagination exceeds 128 pages'], [crowded, 'MCP inventory exceeds 1024 members']] as const) {
      const machine = new MachineRuntime(ctx, { revision: '1', mcp: [
        { serverName: 'remote', transport: 'stdio', command: process.execPath, args: [fixture], cwd: root, env: {} },
      ], skillDirectories: [], hooks: [] }, { id: 'ssh', revision: '1', mcp: { remote: {} }, skills: [], hooks: [] })
      try { await expect(machine.discover(AbortSignal.timeout(20_000), root), message).rejects.toThrow(message) }
      finally { await machine.close() }
    }
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }, 30_000)

  it('runs an allowing hook and joins an in-flight blocking hook at close', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(Skills)
    const machine = new MachineRuntime(ctx, { revision: '1', mcp: [], skillDirectories: [], hooks: [
      { id: 'allower', event: 'pre-tool', argv: ['/bin/true'], cwd: tmpdir(), timeoutMs: 5000 },
    ] }, { id: 'ssh', revision: '2', mcp: {}, skills: [], hooks: ['allower'] })
    try {
      await machine.hook({ event: 'pre-tool', payload: {} }, AbortSignal.timeout(5000))
      await machine.hook({ event: 'post-tool', payload: {} }, AbortSignal.timeout(5000))
    } finally { await machine.close(); await ctx.fiber.dispose() }

    const blocking = new Context()
    await blocking.plugin(LocalSubprocess)
    const blocked = new MachineRuntime(blocking, { revision: '1', mcp: [], skillDirectories: [], hooks: [
      { id: 'sleeper', event: 'pre-tool', argv: ['/bin/sh', '-c', 'sleep 2'], cwd: tmpdir(), timeoutMs: 3000 },
    ] }, { id: 'ssh', revision: '2', mcp: {}, skills: [], hooks: ['sleeper'] })
    try {
      const running = blocked.hook({ event: 'pre-tool', payload: {} }, AbortSignal.timeout(5000))
      await new Promise((resolve) => { setTimeout(resolve, 150) })
      await blocked.close()
      await expect(running).rejects.toThrow('denied the operation')
    } finally { await blocked.close(); await blocking.fiber.dispose() }
  }, 10_000)

  it('rejects unpiped stdio transports, oversized frames, and failing or exiting children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w10-mcp-'))
    const giant = join(root, 'giant.mjs')
    await writeFile(giant, `process.stdout.write('${'x'.repeat(1024 * 1024 + 1)}'); setInterval(() => {}, 1000)`)
    const exiting = join(root, 'exiting.mjs')
    await writeFile(exiting, fixtureServer(`
 if (message.method === 'initialize') { result = {protocolVersion:'2025-11-25',serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{}}}; setTimeout(() => process.exit(0), 50) }
`))
    const config = (command: string, args: string[]) => ({ revision: '1', mcp: [
      { serverName: 'remote', transport: 'stdio' as const, command, args, cwd: root, env: {} },
    ], skillDirectories: [], hooks: [] })

    const pipes = new Context()
    pipes.provide('subprocess', { spawn: () => ({ pid: -1, done: new Promise(() => {}), terminate: () => {}, waitForExit: async () => true }) } as never)
    const unpiped = new MachineRuntime(pipes, config('/bin/cat', []), { id: 'ssh', revision: '1', mcp: { remote: {} }, skills: [], hooks: [] })
    await expect(unpiped.discover(AbortSignal.timeout(5000), root)).rejects.toThrow('stdio MCP transport requires piped helper stdio')
    await unpiped.close()
    await pipes.fiber.dispose()

    const rejecting = new Context()
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- covers the non-Error done rejection branch
    rejecting.provide('subprocess', { spawn: () => ({ pid: -1, stdout: new PassThrough(), stdin: new PassThrough(), done: Promise.reject('plain failure'), terminate: () => {}, waitForExit: async () => true }) } as never)
    const rejected = new MachineRuntime(rejecting, config('/bin/cat', []), { id: 'ssh', revision: '1', mcp: { remote: {} }, skills: [], hooks: [] })
    await expect(rejected.discover(AbortSignal.timeout(5000), root)).rejects.toThrow()
    await rejected.close()
    await rejecting.fiber.dispose()

    const failing = new Context()
    const brokenStdin = new Writable({ write: (_chunk, _encoding, callback) => { callback(new Error('pipe broken')) } })
    brokenStdin.on('error', () => {})
    failing.provide('subprocess', { spawn: () => ({ pid: -1, stdout: new PassThrough(), stdin: brokenStdin, done: new Promise(() => {}), terminate: () => {}, waitForExit: async () => true }) } as never)
    const failingMachine = new MachineRuntime(failing, config('/bin/cat', []), { id: 'ssh', revision: '1', mcp: { remote: {} }, skills: [], hooks: [] })
    await expect(failingMachine.discover(AbortSignal.timeout(5000), root)).rejects.toThrow()
    await failingMachine.close()
    await failing.fiber.dispose()

    const real = new Context()
    await real.plugin(LocalSubprocess)
    const oversize = new MachineRuntime(real, config(process.execPath, [giant]), { id: 'ssh', revision: '1', mcp: { remote: {} }, skills: [], hooks: [] })
    await expect(oversize.discover(AbortSignal.timeout(10_000), root)).rejects.toThrow()
    await oversize.close()

    const graceful = new MachineRuntime(real, config(process.execPath, [exiting]), { id: 'ssh', revision: '1', mcp: { remote: {} }, skills: [], hooks: [] })
    await expect(graceful.discover(AbortSignal.timeout(10_000), root)).rejects.toThrow()
    await graceful.close()

    const exploded = new MachineRuntime(real, config('/nonexistent-mcp-command-w10', []), { id: 'ssh', revision: '1', mcp: { remote: {} }, skills: [], hooks: [] })
    await expect(exploded.discover(AbortSignal.timeout(10_000), root)).rejects.toThrow()
    await exploded.close()
    await real.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }, 30_000)

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
