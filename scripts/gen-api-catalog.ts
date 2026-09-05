/**
 * Generate `docs/api-catalog.json`: the committed, machine-readable inventory
 * of the promised HTTP API surface — legacy unary method metadata, the
 * carrier-owned streaming/download/response endpoints with their required
 * capabilities, and the closed error-code vocabulary. `--check` verifies the
 * artifact is current; `scripts/gen-api-catalog.spec.ts` locks the artifact to
 * runtime metadata and the error schema.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RPC_METHOD_METADATA, CARRIER_ENDPOINT_CAPABILITIES } from '../packages/host/apiproxy/src/api/rpc-map.ts'
import { RPC_ERROR_CODES, CONNECTION_AUTHENTICATED_METHOD } from '../packages/host/apiproxy/src/api/rpc.ts'

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/api-catalog.json'

/** One carrier-owned endpoint row (streaming, download, or client-response). */
interface CarrierEndpointRow {
  readonly endpoint: string
  readonly kind: 'transport-control' | 'stream' | 'download' | 'client-response'
  readonly method: 'GET' | 'POST'
  readonly requiredCapability: string
}

/** The committed catalog shape; version bumps only on incompatible changes. */
export interface ApiCatalog {
  readonly version: 1
  readonly unary: readonly (typeof RPC_METHOD_METADATA)[number][]
  readonly carrier: readonly CarrierEndpointRow[]
  readonly errorCodes: readonly string[]
}

const CARRIER_ENDPOINT_KINDS: Readonly<Record<string, Exclude<CarrierEndpointRow['kind'], 'transport-control'>>> = {
  'events.mux': 'stream',
  'events.host': 'stream',
  'session.export': 'download',
  'respond': 'client-response',
}

/** Assemble the catalog from the compile-locked registries. */
export function buildApiCatalog(): ApiCatalog {
  const carrier: CarrierEndpointRow[] = [
    {
      endpoint: CONNECTION_AUTHENTICATED_METHOD,
      kind: 'transport-control',
      method: 'GET',
      requiredCapability: 'authenticated',
    },
  ]
  for (const [endpoint, capability] of Object.entries(CARRIER_ENDPOINT_CAPABILITIES)) {
    const kind = CARRIER_ENDPOINT_KINDS[endpoint]
    if (kind === undefined) throw new Error(`gen-api-catalog: carrier endpoint "${endpoint}" has no declared kind`)
    carrier.push({
      endpoint,
      kind,
      method: endpoint === 'session.export' ? 'GET' : 'POST',
      requiredCapability: capability,
    })
  }
  return {
    version: 1,
    unary: RPC_METHOD_METADATA.map(entry => ({ ...entry })),
    carrier,
    errorCodes: [...RPC_ERROR_CODES],
  }
}

const check = process.argv.includes('--check')
const rendered = `${JSON.stringify(buildApiCatalog(), null, 2)}\n`
const target = resolve(root, OUT)
if (check) {
  let current: string
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    console.error(`gen-api-catalog: ${OUT} is missing; run \`pnpm run gen-api-catalog\` and commit it.`)
    process.exit(1)
  }
  if (current !== rendered) {
    console.error(`gen-api-catalog: ${OUT} is stale; run \`pnpm run gen-api-catalog\` and commit the refresh.`)
    process.exit(1)
  }
  console.log('gen-api-catalog: docs/api-catalog.json is up to date.')
} else {
  writeFileSync(target, rendered)
  console.log('gen-api-catalog: wrote docs/api-catalog.json.')
}
