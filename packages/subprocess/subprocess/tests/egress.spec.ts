/**
 * Child-process egress under the isolation contract: a scrubbed child carries no proxy
 * variables at all, so its routing cannot inherit (nor choke on) anything this process
 * derived from the user's environment.
 */
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearedProxyEnv, installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '../src/index.ts'

/** Absolute-form requests the fake proxy received; any entry proves a child dialed it. */
let seen: string[] = []
let proxy: Server
let proxyUrl: string
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  seen = []
  const names = Object.keys(clearedProxyEnv())
  saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
  for (const name of names) Reflect.deleteProperty(process.env, name)
})

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
})

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(request.url ?? '')
    response.writeHead(200)
    response.end('VIA-PROXY')
  })
  await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', () => { resolve() }) })
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
})

/** Run a child Node that fetches, using exactly the environment every harness spawner builds. */
function childFetch(target: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['-e', `fetch(${JSON.stringify(target)}).then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('ERR'+String(e.cause?.code)))`],
      { env, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('close', () => { resolve(out.trim()) })
  })
}

describe('child process egress', () => {
  it('severs a scrubbed child from a proxy the user exported, so it fetches directly', async () => {
    // The user's own export is what this process resolves its policy from, so the scenario starts from one.
    process.env.HTTP_PROXY = proxyUrl
    const dispose = await installProxyFromEnvironment(
      createLaunchEnvironmentSnapshot([{ source: 'process', values: { HTTP_PROXY: proxyUrl } }]),
      () => undefined,
    )
    try {
      const childEnv = scrubbedParentEnv()
      expect(childEnv.HTTP_PROXY).toBeUndefined()
      expect(childEnv.http_proxy).toBeUndefined()
      expect(childEnv.NODE_USE_ENV_PROXY).toBeUndefined()
      await childFetch('http://child-probe.invalid/x', childEnv)
      // No names and no flag reach the child, so it cannot dial the proxy on any runtime.
      expect(seen).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('drops the names in every casing the user wrote them, and the bypass list too', async () => {
    process.env.HTTP_PROXY = proxyUrl
    process.env.https_proxy = 'socks5://127.0.0.1:1080'
    process.env.NO_PROXY = 'example.com'
    const dispose = await installProxyFromEnvironment(
      createLaunchEnvironmentSnapshot([{
        source: 'process',
        values: { HTTP_PROXY: proxyUrl, https_proxy: 'socks5://127.0.0.1:1080', NO_PROXY: 'example.com' },
      }]),
      () => undefined,
    )
    try {
      const child = scrubbedParentEnv()
      expect(child.HTTP_PROXY).toBeUndefined()
      expect(child.https_proxy).toBeUndefined()
      expect(child.HTTPS_PROXY).toBeUndefined()
      expect(child.NO_PROXY).toBeUndefined()
      expect(child.no_proxy).toBeUndefined()
      expect(child.ALL_PROXY).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('drops the proxy names when no policy is active either', () => {
    process.env.HTTP_PROXY = proxyUrl
    try {
      expect(scrubbedParentEnv().HTTP_PROXY).toBeUndefined()
    } finally {
      Reflect.deleteProperty(process.env, 'HTTP_PROXY')
    }
  })
})
