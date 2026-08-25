import { describe, expect, it } from 'vitest'

describe('session-reference built exports', () => {
  it('loads the host typert artifact through the public package export', async () => {
    const module = await import('@deepseek-ai/dsh-session-reference/typert')

    expect(module.TYPERT).toMatchObject({
      package: '@deepseek-ai/dsh-session-reference',
      face: 'host',
    })
  })

  it('loads the remote typert artifact through the public package export', async () => {
    const module = await import('@deepseek-ai/dsh-session-reference/remote')

    expect(module.default).toMatchObject({
      package: '@deepseek-ai/dsh-session-reference',
    })
  })
})
