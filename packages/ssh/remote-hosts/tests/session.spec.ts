import { expect, it } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { RemoteHostSshConnection } from '@deepseek-ai/dsh-remote-hosts-ssh'
import { HostSession, synchronize } from '../src/session.ts'

it('rejects synchronization before a remote transport is established', async () => {
  const connection = {
    signal: new AbortController().signal,
    closed: Promise.resolve(),
    async dispose() {},
  } as unknown as RemoteHostSshConnection
  const session = new HostSession(connection, new AbortController())
  await expect(synchronize(session, {} as CredentialProvider, {} as SettingsProvider)).rejects.toThrow('NOT_CONNECTED')
})
