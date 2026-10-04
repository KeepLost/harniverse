import { expect, it } from 'vitest'
import { resolveDurationMs } from '../src/duration-env.ts'

it('uses the fallback when the variable is unset', () => {
  expect(resolveDurationMs({}, 'DSH_TEST_DURATION_MS', 2_500)).toBe(2_500)
})

it('accepts an integer string within the setTimeout range', () => {
  expect(resolveDurationMs({ DSH_TEST_DURATION_MS: '60000' }, 'DSH_TEST_DURATION_MS', 2_500)).toBe(60_000)
})

it.each(['999', '2147483648', '1.5', 'soon'])('rejects %s with the variable named in the error', (value) => {
  expect(() => resolveDurationMs({ DSH_TEST_DURATION_MS: value }, 'DSH_TEST_DURATION_MS', 2_500))
    .toThrow('DSH_TEST_DURATION_MS must be an integer from 1000 through 2147483647')
})
