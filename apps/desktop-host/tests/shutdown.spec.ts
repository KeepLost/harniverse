import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import LocalAuthentication from '@deepseek-ai/dsh-authentication-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Scheduler from '@deepseek-ai/dsh-scheduler'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { expect, it, vi } from 'vitest'
import { DesktopAdmission } from '../src/admission.ts'
import DesktopControl from '../src/control.ts'

it('closes the owned Agent before scheduler disposal can wait indefinitely for its idle boundary', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-shutdown-'))
  const config = join(home, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { id: 'admission', name: 'cordis:admission' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'storage', name: 'cordis:storage' }, { id: 'json', name: 'cordis:json', config: { root: join(home, 'storage') } },
    { id: 'domain', name: 'cordis:domain', config: { backend: 'json' } },
    { id: 'auth', name: 'cordis:auth', config: { dshHome: home, watch: false } },
    { id: 'agent', name: 'cordis:agent' }, { id: 'scheduler', name: 'cordis:scheduler' },
    { id: 'control', name: 'cordis:control', config: { home } },
  ]))
  let idle!: () => void
  let waited!: () => void
  const idleBoundary = new Promise<void>((resolve) => { idle = resolve })
  const waiting = new Promise<void>((resolve) => { waited = resolve })
  let closed = false
  const followup = vi.fn()
  const ctx = await boot('desktop-shutdown-test', config, undefined, (ctx) => {
    Object.assign(ctx.loader.builtins, {
      admission: DesktopAdmission, sessions: SessionStore, storage: Storage, json: StorageJson,
      domain: StorageDomain, auth: LocalAuthentication, scheduler: Scheduler, control: DesktopControl,
      agent: { name: 'busy-agent', inject: ['sessions'], apply(ctx: Context) {
        const session = ctx.sessions.create(SessionId('busy'))
        const agent = { id: session.id, session, status: 'running', followup,
          whenIdle() { waited(); return idleBoundary },
          runMaintenance() { throw new Error(closed ? 'Agent is closing' : 'Agent is running') },
        }
        ctx.provide('agents', {
          list: () => closed ? [] : [agent], get: () => closed ? undefined : agent,
          async close() { closed = true; idle(); return true },
        })
        ctx.provide('apiProxy', { sessions: { status: async () => ({ result: { ok: false } }) } })
        ctx.provide('terminalController', { list: () => [] })
      } },
    })
  })
  try {
    await ctx.scheduler.create({ prompt: 'pending', rule: { kind: 'after', delayMs: 1 },
      target: { kind: 'current' }, contextMode: 'continue', createdBy: { kind: 'user', sessionId: SessionId('busy') } })
    await waiting
    await ctx.desktopControl.quiesce()
    expect(closed).toBe(true)
    await ctx.fiber.dispose()
    expect(followup).not.toHaveBeenCalled()
    expect(ctx.get('scheduler')).toBeUndefined()
  } finally { idle(); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
