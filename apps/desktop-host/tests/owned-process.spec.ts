import { fork } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { healProfilesModuleFallback } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
import { OwnedDesktopHostProcess } from '../../desktop/src/owned-host.ts'

it('boots the installed web profile with private IPC and stops its actual process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-process-'))
  const home = join(root, 'home')
  const anchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
  // Relocate the built app beside the normal CLI dependency closure, without installing packages.
  healProfilesModuleFallback(anchor, root)
  const entry = join(root, 'profiles', 'desktop-host.mjs')
  await copyFile(fileURLToPath(new URL('../lib/index.js', import.meta.url)), entry)
  await mkdir(home, { mode: 0o700 })
  const child = fork(entry, [home, anchor, '--port', '0'], { cwd: home, execArgv: ['--expose-internals'],
    env: { PATH: '', HOME: root, ...process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {} }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const messages: Record<string, unknown>[] = []
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-12000) })
  child.on('message', (message: Record<string, unknown>) => { messages.push(message) })
  const startup = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error(`Desktop boot timed out: ${stderr}`)) }, 20000)
    child.on('message', (message: Record<string, unknown>) => {
      if (message.type === 'ready') { clearTimeout(timeout); resolve(message) }
      if (message.type === 'fatal') { clearTimeout(timeout); reject(new Error(String(message.message))) }
    })
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Desktop exited ${String(code)}: ${stderr}`)) })
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve)
    child.once('error', reject)
  })
  try {
    const ready = await startup
    const url = new URL(String(ready.url))
    expect(url.hostname).toBe('127.0.0.1')
    expect(Number(url.port)).toBeGreaterThan(0)
    expect((await fetch(new URL('/api/session.list', url), { method: 'POST' })).status).toBe(401)
    const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    child.send({ type: 'enroll', requestId: 1, publicKey: device.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') })
    await expect.poll(() => messages.find(message => message.type === 'enrolled'), { timeout: 3000 }).toBeDefined()
    const enrollment = messages.find(message => message.type === 'enrolled')!.enrollment as { grant: { id: string } }
    const json = async (path: string, body: object) => fetch(new URL(path, url), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: url.origin }, body: JSON.stringify(body),
    })
    const challengeResponse = await json('/auth/challenge', { grantId: enrollment.grant.id, purpose: 'browser-session' })
    expect(challengeResponse.status).toBe(200)
    const challenge = await challengeResponse.json() as { id: string; payload: string }
    const exchanged = await json('/auth/exchange', { challengeId: challenge.id,
      signature: sign('sha256', Buffer.from(challenge.payload), { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') })
    expect(exchanged.status).toBe(200)
    expect(await exchanged.json()).toMatchObject({ authenticated: true })
    const cookie = exchanged.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeDefined()
    const listed = await fetch(new URL('/api/session.list', url), { method: 'POST',
      headers: { cookie: cookie!, origin: url.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: 'session.list', rpcId: 'desktop-smoke', requestId: 'desktop-request', payload: {} }) })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ result: { ok: true } })
    child.send({ type: 'activity', requestId: 2 })
    await expect.poll(() => messages.find(message => message.type === 'activity'), { timeout: 3000 }).toMatchObject({ activity: { status: 'idle' } })
    child.send({ type: 'shutdown' })
    expect(await exited).toBe(0)
    expect(messages.at(-1)).toEqual({ type: 'shutdown-complete' })
    await expect(fetch(url)).rejects.toThrow()
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('uses the real parent adapter for authenticated enrollment, update locks and acknowledged process close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-adapter-'))
  const anchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
  healProfilesModuleFallback(anchor, root)
  const entry = join(root, 'profiles', 'desktop-host.mjs')
  await copyFile(fileURLToPath(new URL('../lib/index.js', import.meta.url)), entry)
  const failures: Error[] = []
  const host = new OwnedDesktopHostProcess(entry, join(root, 'home'), anchor, {
    onFailure: error => failures.push(error), pickDirectory: async () => ({ kind: 'cancelled' }),
  }, { port: 0, startupTimeoutMs: 20000 })
  try {
    const ready = await host.start()
    expect(await host.activity()).toEqual({ status: 'unknown' })
    const device = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const enrollment = await host.enroll(device.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'))
    expect(enrollment.grant.id).not.toBe('')
    await expect.poll(() => host.activity(), { timeout: 3000 }).toEqual({ status: 'idle', sessions: 0, tasks: 0 })
    expect(await host.updateTasks('lock')).toEqual({ status: 'idle', sessions: 0, tasks: 0 })
    expect((await fetch(new URL('/api/session.list', ready.url), { method: 'POST' })).status).toBe(503)
    expect(await host.updateTasks('unlock')).toEqual({ status: 'idle', sessions: 0, tasks: 0 })
    expect((await fetch(new URL('/api/session.list', ready.url), { method: 'POST' })).status).toBe(401)
    await host.stop()
    expect(failures).toEqual([])
    await expect(fetch(ready.url)).rejects.toThrow()
  } finally { try { await host.stop() } finally { await rm(root, { recursive: true, force: true }) } }
}, 30000)
