import z from '@deepseek-ai/schemastery'
import { expect, it } from 'vitest'
import { buildSnapshot } from '../src/sync.ts'

const reverseMapping = {
  localHost: '127.0.0.1',
  localPort: 9000,
  remoteOriginalOrigin: 'http://model-gateway.test:9000',
  remotePort: 31001,
} as const

it('resolves only schema-declared credential refs inside configured model/search namespaces', async () => {
  const schema = z.object({ providers: z.dict(z.object({ keys: z.array(z.string().role('credential-ref')), arbitrary: z.string() })) })
  const resolved: string[] = []
  const snapshot = await buildSnapshot({ describe: () => [
    { ns: 'llm-pi-ai', schema: schema.toJSON(), value: { providers: { model: { keys: ['MODEL_KEY'], arbitrary: 'PRIVATE_KEY' } } } },
    { ns: 'unrelated', schema: z.object({ key: z.string().role('credential-ref') }).toJSON(), value: { key: 'OTHER_SECRET' } },
  ] } as never, { resolve: async (ref: string) => { resolved.push(ref); return { value: 'model-value' } } } as never)
  expect(resolved).toEqual(['MODEL_KEY'])
  expect(snapshot.credentials).toEqual({ MODEL_KEY: 'model-value' })
  expect(snapshot.settings['llm-pi-ai']).toEqual({ providers: { model: { keys: ['MODEL_KEY'], arbitrary: 'PRIVATE_KEY' } } })
  expect(snapshot.settings['model-routes']).toBeUndefined()
  expect(snapshot.settings.unrelated).toBeUndefined()
})

it('moves supported inline search keys into the encrypted snapshot, never remote plaintext settings', async () => {
  const schema = z.object({ apiKey: z.string().role('secret'), apiKeyEnv: z.string().role('credential-ref') })
  const snapshot = await buildSnapshot({ describe: () => [{ ns: 'web-search-exa', schema: schema.toJSON(),
    value: { apiKey: 'literal-secret', apiKeyEnv: 'EXA_API_KEY' } }] } as never,
  { resolve: async () => ({ value: 'shadowed-reference' }) } as never)
  expect(snapshot.settings).toEqual({ 'web-search-exa': { apiKeyEnv: 'EXA_API_KEY' } })
  expect(snapshot.credentials).toEqual({ EXA_API_KEY: 'literal-secret' })
})

it('rewrites configured model and search origins to their allocated remote loopback ports', async () => {
  const schema = z.object({
    baseURL: z.string(),
    fallback: z.array(z.string()),
  })
  const snapshot = await buildSnapshot({ describe: () => [
    { ns: 'llm-deepseek', schema: schema.toJSON(), value: {
      baseURL: 'http://model-gateway.test:9000/v1',
      fallback: ['http://model-gateway.test:9000', 'https://other.test/v1'],
    } },
    { ns: 'unrelated', schema: z.object({ url: z.string() }).toJSON(), value: { url: 'http://model-gateway.test:9000' } },
  ] } as never, { resolve: async () => undefined } as never, [reverseMapping])

  expect(snapshot.settings['llm-deepseek']).toEqual({
    baseURL: 'http://127.0.0.1:31001/v1',
    fallback: ['http://127.0.0.1:31001', 'https://other.test/v1'],
  })
  expect(snapshot.settings.unrelated).toBeUndefined()
})
