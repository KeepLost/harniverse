import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  let finish!: (fingerprint: string) => void
  const connected = new Promise<string>((resolve) => { finish = resolve })
  return { connected, finish, disposals: 0 }
})

vi.mock('../src/connection.ts', () => ({
  SshTransport: class {
    readonly signal = new AbortController().signal
    readonly closed = Promise.resolve()
    connect(): Promise<string> { return state.connected }
    async dispose(): Promise<void> { state.disposals++ }
  },
}))

import RemoteHostSsh from '../src/index.ts'

it('disposes a transport whose handshake settles after provider disposal starts', async () => {
  state.disposals = 0
  const service = new RemoteHostSsh(new Context())
  const config = {
    host: 'fixture.invalid', port: 22, username: 'runner',
    fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }
  const opening = service.open(config, { kind: 'password', password: 'secret' })
  await Promise.resolve()
  await service.dispose()
  state.finish(config.fingerprint)
  await expect(opening).rejects.toMatchObject({ code: 'CLOSED' })
  expect(state.disposals).toBe(1)
})
