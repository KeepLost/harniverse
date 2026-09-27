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

it('deduplicates an identical inline search credential referenced by multiple namespaces', async () => {
  const schema = z.object({ apiKey: z.string().role('secret'), apiKeyEnv: z.string().role('credential-ref') })
  const snapshot = await buildSnapshot({ describe: () => [
    { ns: 'web-search-exa', schema: schema.toJSON(), value: { apiKey: 'same-secret', apiKeyEnv: 'SHARED_KEY' } },
    { ns: 'web-search-kagi', schema: schema.toJSON(), value: { apiKey: 'same-secret', apiKeyEnv: 'SHARED_KEY' } },
  ] } as never, { resolve: async () => undefined } as never)
  expect(snapshot.credentials).toEqual({ SHARED_KEY: 'same-secret' })
})

it('rewrites configured model and search origins to their allocated remote loopback ports', async () => {
  const schema = z.object({
    baseURL: z.string(),
    fallback: z.array(z.string()),
    enabled: z.boolean(),
  })
  const snapshot = await buildSnapshot({ describe: () => [
    { ns: 'llm-deepseek', schema: schema.toJSON(), value: {
      baseURL: 'http://model-gateway.test:9000/v1',
      fallback: ['http://model-gateway.test:9000', 'https://other.test/v1'],
      enabled: true,
    } },
    { ns: 'unrelated', schema: z.object({ url: z.string() }).toJSON(), value: { url: 'http://model-gateway.test:9000' } },
  ] } as never, { resolve: async () => undefined } as never, [reverseMapping])

  expect(snapshot.settings['llm-deepseek']).toEqual({
    baseURL: 'http://127.0.0.1:31001/v1',
    fallback: ['http://127.0.0.1:31001', 'https://other.test/v1'],
    enabled: true,
  })
  expect(snapshot.settings.unrelated).toBeUndefined()
})

it('rejects unsafe references, unsupported inline secrets, conflicts, and non-object settings', async () => {
  const refSchema = z.object({ credential: z.string().role('credential-ref') })
  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: refSchema.toJSON(), value: { credential: 'DSH_REMOTE_HOST_X' } }] } as never,
    { resolve: async () => undefined } as never)).rejects.toThrow('INVALID_SYNC_REFERENCE')

  const inlineSchema = z.object({ apiKey: z.string().role('secret') })
  await expect(buildSnapshot({ describe: () => [{ ns: 'web-search-exa', schema: inlineSchema.toJSON(), value: { apiKey: 'secret' } }] } as never,
    { resolve: async () => undefined } as never)).rejects.toThrow('UNSUPPORTED_INLINE_SECRET')

  const first = z.object({ apiKey: z.string().role('secret'), apiKeyEnv: z.string().role('credential-ref') })
  await expect(buildSnapshot({ describe: () => [
    { ns: 'web-search-exa', schema: first.toJSON(), value: { apiKey: 'one', apiKeyEnv: 'EXA_KEY' } },
    { ns: 'web-search-kagi', schema: first.toJSON(), value: { apiKey: 'two', apiKeyEnv: 'EXA_KEY' } },
  ] } as never, { resolve: async () => undefined } as never)).rejects.toThrow('CONFLICTING_INLINE_SECRET')

  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: z.object({}).toJSON(), value: [] }] } as never,
    { resolve: async () => undefined } as never)).rejects.toThrow('INVALID_SYNC_SETTINGS')

  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: {
    type: 'object', dict: { model: { type: 'union', list: [{ type: 'string', meta: { role: 'credential-ref' } }] } },
  }, value: { model: 'MODEL_KEY' } }] } as never, { resolve: async () => undefined } as never))
    .rejects.toThrow('UNSUPPORTED_SYNC_SCHEMA')

  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: {
    type: 'object', dict: { model: { type: 'intersect', list: [{ type: 'string' }, { type: 'string' }] } },
  }, value: { model: 'MODEL_KEY' } }] } as never, { resolve: async () => undefined } as never)).resolves.toMatchObject({
    credentials: {},
  })
})

it('ignores absent references, omits empty inline credentials, and detects recursive ambiguous schemas', async () => {
  const reference = z.object({ key: z.string().role('credential-ref') })
  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: reference.toJSON(), value: { key: null } }] } as never,
    { resolve: async () => undefined } as never)).resolves.toMatchObject({ credentials: {} })
  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: reference.toJSON(), value: { key: '' } }] } as never,
    { resolve: async () => undefined } as never)).resolves.toMatchObject({ credentials: {} })

  const optionalInline = z.object({ apiKey: z.string().role('secret'), apiKeyEnv: z.string().role('credential-ref') })
  await expect(buildSnapshot({ describe: () => [{ ns: 'web-search-exa', schema: optionalInline.toJSON(), value: { apiKeyEnv: 'OPTIONAL_KEY' } }] } as never,
    { resolve: async () => undefined } as never)).resolves.toMatchObject({ credentials: {} })

  const secretArray = { type: 'object', dict: { keys: { type: 'array', inner: { type: 'string', meta: { role: 'secret' } } } } }
  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: secretArray, value: { keys: ['inline'] } }] } as never,
    { resolve: async () => undefined } as never)).rejects.toThrow('UNSUPPORTED_INLINE_SECRET')

  const inline = z.object({ apiKey: z.string().role('secret'), apiKeyEnv: z.string().role('credential-ref') })
  await expect(buildSnapshot({ describe: () => [{ ns: 'web-search-exa', schema: inline.toJSON(), value: { apiKey: '', apiKeyEnv: 'EMPTY_KEY' } }] } as never,
    { resolve: async () => undefined } as never)).resolves.toMatchObject({
    settings: { 'web-search-exa': { apiKeyEnv: 'EMPTY_KEY' } }, credentials: {},
  })

  const recursive: { type: string; list: unknown[] } = { type: 'union', list: [] }
  recursive.list.push(recursive, { type: 'string', meta: { role: 'credential-ref' } })
  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: {
    type: 'object', dict: { key: recursive },
  }, value: { key: 'MODEL_KEY' } }] } as never, { resolve: async () => undefined } as never))
    .rejects.toThrow('UNSUPPORTED_SYNC_SCHEMA')

  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: {
    type: 'object', dict: { model: { type: 'union', list: [
      { type: 'array', inner: { type: 'string', meta: { role: 'credential-ref' } } }, { type: 'number' },
    ] } },
  }, value: { model: 'local-value' } }] } as never, { resolve: async () => undefined } as never))
    .rejects.toThrow('UNSUPPORTED_SYNC_SCHEMA')

  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: {
    type: 'object', dict: { model: { type: 'transform', inner: { type: 'string' } } },
  }, value: { model: 'local-value' } }] } as never, { resolve: async () => undefined } as never))
    .resolves.toMatchObject({ credentials: {} })

  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: {
    type: 'object', dict: { model: { type: 'union', list: [{ type: 'string' }, { type: 'number' }] } },
  }, value: { model: 'local-value' } }] } as never, { resolve: async () => undefined } as never))
    .resolves.toMatchObject({ credentials: {} })
  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: {
    type: 'object', dict: { plain: {} },
  }, value: { plain: 'local-value' } }] } as never, { resolve: async () => undefined } as never))
    .resolves.toMatchObject({ credentials: {} })

  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: { type: 'object' }, value: {} }] } as never,
    { resolve: async () => undefined } as never)).resolves.toMatchObject({ credentials: {} })
  await expect(buildSnapshot({ describe: () => [{ ns: 'llm-deepseek', schema: {
    type: 'object', dict: { model: { type: 'intersect' } },
  }, value: { model: 'local-value' } }] } as never, { resolve: async () => undefined } as never))
    .resolves.toMatchObject({ credentials: {} })
})
