
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import GovernorService from '../src/index.ts'

describe('pre-init guards', () => {
  it('rejects quota and engine reads before Service.init completes', () => {
    const service = new GovernorService(new Context(), undefined, {})
    expect(() => service.limitsFor('s')).toThrow(/before Service\.init/)
    expect(() => service.breachFor('c')).toThrow(/before Service\.init/)
  })
})
