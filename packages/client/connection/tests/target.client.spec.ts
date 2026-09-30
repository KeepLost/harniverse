// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createTargetPathResolver, isHostManagement, TargetGeneration } from '../src/client/target.ts'

describe('remote browser target routing', () => {
  it('adds the target to API carriers while keeping remote-host management local', () => {
    const resolve = createTargetPathResolver({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    expect(resolve('/api/sessions/list')).toBe('/api/sessions/list?dshRemoteHost=11111111-1111-4111-8111-111111111111')
    expect(resolve('/api/events.mux?since=%7B%7D')).toContain('dshRemoteHost=11111111-1111-4111-8111-111111111111')
    expect(resolve('/api/remoteHosts/list')).toBe('/api/remoteHosts/list')
    expect(resolve('/api/settings/list')).toBe('/api/settings/list')
    expect(resolve('/api/credentials/list')).toBe('/api/credentials/list')
  })

  it('keeps legacy dotted settings and credentials methods local', () => {
    const resolve = createTargetPathResolver({ kind: 'remote', id: '11111111-1111-4111-8111-111111111111' })
    expect(resolve('/api/settings.describe')).toBe('/api/settings.describe')
    expect(resolve('/api/settings.update')).toBe('/api/settings.update')
    expect(resolve('/api/credentials.describe')).toBe('/api/credentials.describe')
    expect(resolve('/api/credentials.set')).toBe('/api/credentials.set')
    // A namespace merely sharing the prefix is not local.
    expect(resolve('/api/sessions.list')).toBe('/api/sessions.list?dshRemoteHost=11111111-1111-4111-8111-111111111111')
    expect(resolve('/api/settingsPreview.read')).toBe('/api/settingsPreview.read?dshRemoteHost=11111111-1111-4111-8111-111111111111')
    expect(resolve('/api/')).toContain('dshRemoteHost=11111111-1111-4111-8111-111111111111')
    expect(resolve('/api-sessions/list')).toBe('/api-sessions/list')
    expect(resolve('/auth/status')).toBe('/auth/status')
  })

  it('keeps host target paths unchanged', () => {
    expect(createTargetPathResolver({ kind: 'host' })('/api/sessions/list')).toBe('/api/sessions/list')
    expect(isHostManagement('')).toBe(false)
  })

  it('normalizes non-Error carrier failures without leaking a late result', async () => {
    const generation = new TargetGeneration({ kind: 'host' })
    const failure = Promise.withResolvers<never>()
    const result = expect(generation.run(() => failure.promise)).rejects.toThrow('offline')
    failure.reject('offline')
    await result
  })
})
