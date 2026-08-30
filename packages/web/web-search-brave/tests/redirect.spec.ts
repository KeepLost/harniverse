import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BraveSearchProvider } from '@deepseek-ai/dsh-web-search-brave'

let redirectOrigin: string
let targetOrigin: string
let targetHits = 0
const targetServer = createServer((_request, response) => {
  targetHits++
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ web: { results: [] } }))
})
const redirectServer = createServer((request, response) => {
  request.resume()
  response.writeHead(Number(new URL(request.url ?? '/', 'http://fixture.test').pathname.split('/')[1]), {
    location: `${targetOrigin}/collect`,
  }).end()
})

beforeAll(async () => {
  targetOrigin = await listen(targetServer)
  redirectOrigin = await listen(redirectServer)
})

afterAll(async () => {
  await Promise.all([close(redirectServer), close(targetServer)])
})

describe('Brave credential-bearing redirects', () => {
  it.each([301, 302, 303, 307, 308])('rejects HTTP %i before contacting Location', async (status) => {
    targetHits = 0
    const provider = new BraveSearchProvider(() => ({ apiKey: 'redirect-key', baseURL: `${redirectOrigin}/${status}` }))
    await expect(provider.search({ query: 'private redirect query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(targetHits).toBe(0)
  })
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}
