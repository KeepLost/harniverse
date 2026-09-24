import { describe, expect, it } from 'vitest'
import { assertShellSender, parseConnectionProfile, validateHostUrl, quitWarning } from '../src/ipc.ts'

describe('desktop connection trust', () => {
  it.each(['https://example.org/', 'http://127.0.0.1:4921/', 'http://localhost:4921/', 'http://[::1]:4921/'])('accepts a protected Host URL %s', (url) => {
    expect(validateHostUrl(url)).toBe(url)
  })

  it.each(['http://example.org', 'http://192.168.1.2', 'file:///etc/passwd', 'javascript:alert(1)',
    'https://name:password@example.org', 'https://example.org/?token=secret', 'https://example.org/#token',
    'https://example.org/path', 'https://example.org\\@evil.test', ' http://localhost'])('rejects an unsafe Host URL %s', (url) => {
    expect(() => validateHostUrl(url)).toThrow()
  })

  it('keeps a loopback tunnel external and rejects executable or path configuration', () => {
    expect(parseConnectionProfile({ kind: 'existingHost', url: 'http://localhost:9000' })).toEqual({ kind: 'existingHost', url: 'http://localhost:9000/' })
    expect(() => parseConnectionProfile({ kind: 'local', executable: '/tmp/program' })).toThrow()
    expect(() => parseConnectionProfile({ kind: 'local', path: '/remote/workspace' })).toThrow()
  })
})

describe('desktop IPC ownership', () => {
  const frame = { url: 'https://host.test/', origin: 'https://host.test' }
  const sender = { mainFrame: frame }

  it('accepts only the owned main frame at the active origin', () => {
    expect(() => { assertShellSender({ sender, senderFrame: frame }, sender, { kind: 'web', origin: 'https://host.test' }) }).not.toThrow()
    expect(() => { assertShellSender({ sender: { mainFrame: frame }, senderFrame: frame }, sender, { kind: 'web', origin: 'https://host.test' }) }).toThrow()
    expect(() => { assertShellSender({ sender, senderFrame: { ...frame } }, sender, { kind: 'web', origin: 'https://host.test' }) }).toThrow()
    expect(() => { assertShellSender({ sender, senderFrame: frame }, sender, { kind: 'web', origin: 'https://other.test' }) }).toThrow()
  })

  it('rejects inherited origins and accepts only the exact shell file', () => {
    const inherited = { url: 'about:blank', origin: 'https://host.test' }
    const owner = { mainFrame: inherited }
    expect(() => { assertShellSender({ sender: owner, senderFrame: inherited }, owner, { kind: 'web', origin: 'https://host.test' }) }).toThrow()
    const local = { url: 'file:///app/renderer/index.html', origin: 'null' }
    const localOwner = { mainFrame: local }
    expect(() => { assertShellSender({ sender: localOwner, senderFrame: local }, localOwner, { kind: 'shell', url: local.url }) }).not.toThrow()
    expect(() => { assertShellSender({ sender: localOwner, senderFrame: local }, localOwner, { kind: 'shell', url: 'file:///other.html' }) }).toThrow()
  })
})

describe('desktop quit explanation', () => {
  it('warns when owned activity is active or unknown and explains external ownership', () => {
    expect(quitWarning('owned', { status: 'active', sessions: 1, tasks: 2 })).toContain('stop')
    expect(quitWarning('owned', { status: 'unknown' })).toContain('unavailable')
    expect(quitWarning('external', { status: 'active', sessions: 1, tasks: 2 })).toContain('continues')
    expect(quitWarning('owned', { status: 'idle', sessions: 0, tasks: 0 })).toBeUndefined()
  })
})
