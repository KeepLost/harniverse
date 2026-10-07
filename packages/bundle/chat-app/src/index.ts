/**
 * The chat profile runner. `run` leaves the mounted bridge to serve until the
 * process stops; `init`, `status`, and `rotate-key` are one-shot maintenance
 * over the profile's credentials and storage, then request a bounded exit.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  createAuthenticationClientGrant, isAuthenticationGrantActive, listAuthenticationGrants, revokeAuthenticationGrant,
  type AuthenticationGrant,
} from '@deepseek-ai/dsh-authentication-local'
import { authenticationGrantId } from '@deepseek-ai/dsh-authentication'
import { bridgeDomainSpec, DEFAULT_OWNER_CODE_TTL_MS, issueCode } from '@deepseek-ai/dsh-chat-bridge'
import { DEFAULT_GRANT_ID_REF, DEFAULT_SIGNING_KEY_REF } from '@deepseek-ai/dsh-chat-harniverse-client'
import type {} from '@deepseek-ai/dsh-cmdline'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { ChatOperation } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'chat-runner'

/** Parsed app invocation, credentials, and storage required before the runner starts. */
export const inject = ['chatStartup', 'credentials', 'storageDomain']

/** Grant name the first `init` registers. */
export const GRANT_NAME = 'chat-bridge'

/** Capabilities the bridge needs and nothing more: streams and prompts. */
export const GRANT_CAPABILITIES = ['harniverse.observe', 'harniverse.operate'] as const

/** Runner configuration. */
export interface Config {
  /** What this invocation does; `run` leaves the mounted bridge serving. */
  operation: ChatOperation
  /** Harniverse origin `status` probes. */
  origin?: string
  /** Harness home holding the Grant registry and the profile patch. */
  dshHome?: string
}

/** Loader validation for the runner row. */
export const Config: z<Config> = z.object({
  operation: z.union([z.const('run'), z.const('init'), z.const('status'), z.const('rotate-key')]).required(),
  origin: z.string(),
  dshHome: z.string(),
})

interface TextOutput {
  write(value: string): unknown
}

/** Process streams and transports the runner uses; tests replace them. */
export const internals: {
  stdout: TextOutput
  stderr: TextOutput
  fetch: typeof globalThis.fetch
  createGrant: typeof createAuthenticationClientGrant
} = {
  stdout: process.stdout,
  stderr: process.stderr,
  fetch: globalThis.fetch.bind(globalThis),
  createGrant: createAuthenticationClientGrant,
}

/** The profile patch written when the owner has none yet. */
export const PATCH_TEMPLATE = `# Your dsh chat configuration. Edit it, then restart \`dsh chat\`.
# A patch replaces a row's whole config, so keep every key you want.
#
# owners act with full command access and receive every approval. members are
# default-deny: each listed command, workspace alias, and Agent Profile is an
# explicit grant. A member without userId joins with a pairing code from
# /invite; set dshRemoteHost to forward that member's sessions to a remote runtime.
- id: chat-bridge
  config:
    owners: []
    # - { platform: telegram, userId: "123456789" }
    members: []
    # - id: alice
    #   platform: telegram
    #   commands: [new, ask, stop, steer, sessions, session, ws, model, title, compact, plan]
    #   workspaces: [alice]
    #   agentProfile: chat-code
    #   answerOwnApprovals: false
    workspaceAliases: {}
    # alice: /home/owner/HarniverseIM/members/alice
    imRoot: ~/HarniverseIM

# Telegram: store the bot token with the credentials provider, then list it here.
- id: chat-telegram
  config:
    bots: []
    # - { tokenRef: TELEGRAM_BOT_TOKEN }

# Feishu / Lark: store the app secret with the credentials provider, then list it here.
- id: chat-feishu
  config:
    apps: []
    # - { appId: cli_xxxxxxxxxxxxxxxx, secretRef: FEISHU_APP_SECRET }
`

interface SigningKey {
  /** PKCS#8 DER, base64url. */
  privateKey: string
  /** SPKI DER, base64url. */
  publicKey: string
}

function generateSigningKey(): SigningKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
}

/** Parse a stored signing key and derive its public half. */
function signingKeyFrom(privateKey: string): SigningKey {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
  if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`chat-runner: credential ${DEFAULT_SIGNING_KEY_REF} is not a P-256 key; run \`dsh chat rotate-key\``)
  }
  return { privateKey, publicKey: createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url') }
}

async function read(credentials: CredentialProvider, ref: string): Promise<string | undefined> {
  return (await credentials.resolve(credentialRef(ref)))?.value
}

function describeGrant(grant: AuthenticationGrant): string {
  return `${grant.id} (${grant.name}, ${grant.capabilities.join(',')})`
}

async function registerGrant(name: string, publicKey: string, options: { dshHome?: string }): Promise<AuthenticationGrant> {
  try {
    return await internals.createGrant({ name, publicKey, capabilities: GRANT_CAPABILITIES }, options)
  } catch (error) {
    if (error instanceof Error && error.message.includes('first active Grant must authorize')) {
      throw new Error('Harniverse has no owner yet: start `dsh web`, finish the browser device login, then run `dsh chat init` again')
    }
    throw error
  }
}

/** Write the configuration template unless the owner already edited the patch. */
async function writeTemplate(path: string): Promise<boolean> {
  let current: string | undefined
  try {
    current = await readFile(path, 'utf8')
  } catch {
    // A missing patch is the normal first-run state: the template is written below.
    current = undefined
  }
  const pristine = current === undefined || current.split('\n').filter(line => !line.trimStart().startsWith('#')).join('').trim() === '[]' || current.trim() === ''
  if (!pristine) return false
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, PATCH_TEMPLATE)
  return true
}

async function init(ctx: Context, config: Config): Promise<string[]> {
  const options = config.dshHome === undefined ? {} : { dshHome: config.dshHome }
  const stored = await read(ctx.credentials, DEFAULT_SIGNING_KEY_REF)
  const key = stored === undefined ? generateSigningKey() : signingKeyFrom(stored)
  if (stored === undefined) await ctx.credentials.set(credentialRef(DEFAULT_SIGNING_KEY_REF), key.privateKey)
  const grants = await listAuthenticationGrants(options)
  const grantId = await read(ctx.credentials, DEFAULT_GRANT_ID_REF)
  const existing = grantId === undefined ? grants.find(grant => grant.name === GRANT_NAME) : grants.find(grant => grant.id === grantId)
  let grant: AuthenticationGrant
  if (existing === undefined) {
    grant = await registerGrant(grants.some(candidate => candidate.name === GRANT_NAME) ? `${GRANT_NAME}-${timestamp()}` : GRANT_NAME, key.publicKey, options)
  } else {
    if (existing.publicKey !== key.publicKey || existing.kind !== 'api-client' || !isAuthenticationGrantActive(existing)
      || GRANT_CAPABILITIES.some(capability => !existing.capabilities.includes(capability))) {
      throw new Error(`chat-runner: Grant ${existing.id} does not match the stored signing key; run \`dsh chat rotate-key\``)
    }
    grant = existing
  }
  if (grantId !== grant.id) await ctx.credentials.set(credentialRef(DEFAULT_GRANT_ID_REF), grant.id)
  const patchPath = join(resolveDshHome(config.dshHome), 'profiles', 'chat', 'patch.yml')
  const wrote = await writeTemplate(patchPath)
  const ttl = DEFAULT_OWNER_CODE_TTL_MS
  const state = await ctx.storageDomain.open(bridgeDomainSpec)
  let code: string
  try {
    code = await issueCode(state.table('codes'), { kind: 'owner', expiresAt: Date.now() + ttl })
  } finally {
    await state.close()
  }
  return [
    `signing key: ${stored === undefined ? 'created' : 'reused'} (${DEFAULT_SIGNING_KEY_REF})`,
    `grant: ${existing === undefined ? 'registered' : 'reused'} ${describeGrant(grant)}`,
    `config: ${wrote ? 'wrote a template to' : 'kept'} ${patchPath}`,
    `owner pairing code (valid ${String(Math.round(ttl / 60_000))} minutes): ${code}`,
    'Send "/pair <code>" to your bot in a private chat to become the owner.',
  ]
}

function timestamp(): string {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 14)
}

async function rotate(ctx: Context, config: Config): Promise<string[]> {
  const options = config.dshHome === undefined ? {} : { dshHome: config.dshHome }
  const oldId = await read(ctx.credentials, DEFAULT_GRANT_ID_REF)
  if (oldId === undefined || await read(ctx.credentials, DEFAULT_SIGNING_KEY_REF) === undefined) {
    throw new Error('chat-runner: nothing to rotate; run `dsh chat init` first')
  }
  const key = generateSigningKey()
  const grant = await registerGrant(`${GRANT_NAME}-${timestamp()}`, key.publicKey, options)
  await ctx.credentials.set(credentialRef(DEFAULT_SIGNING_KEY_REF), key.privateKey)
  await ctx.credentials.set(credentialRef(DEFAULT_GRANT_ID_REF), grant.id)
  const old = (await listAuthenticationGrants(options)).find(candidate => candidate.id === oldId)
  if (old !== undefined) await revokeAuthenticationGrant(authenticationGrantId(old.id), options)
  return [`signing key: replaced (${DEFAULT_SIGNING_KEY_REF})`, `grant: registered ${describeGrant(grant)}`, old === undefined ? 'old grant: already gone' : `old grant: revoked ${old.id}`]
}

async function status(ctx: Context, config: Config): Promise<string[]> {
  const options = config.dshHome === undefined ? {} : { dshHome: config.dshHome }
  const lines: string[] = []
  const stored = await read(ctx.credentials, DEFAULT_SIGNING_KEY_REF)
  lines.push(`signing key: ${stored === undefined ? 'missing (run `dsh chat init`)' : 'present'}`)
  const grantId = await read(ctx.credentials, DEFAULT_GRANT_ID_REF)
  const grant = grantId === undefined ? undefined : (await listAuthenticationGrants(options)).find(candidate => candidate.id === grantId)
  lines.push(grant === undefined
    ? 'grant: missing (run `dsh chat init`)'
    : `grant: ${describeGrant(grant)} ${isAuthenticationGrantActive(grant) ? 'active' : 'expired'}`)
  const origin = config.origin ?? 'http://127.0.0.1:3080'
  try {
    const response = await internals.fetch(new URL('/auth/status', origin), { signal: AbortSignal.timeout(2_000) })
    const body = await response.json() as { mode?: string }
    lines.push(`harniverse ${origin}: reachable, authentication ${body.mode ?? 'unknown'}`)
  } catch (error) {
    lines.push(`harniverse ${origin}: unreachable (${error instanceof Error ? error.message : String(error)})`)
  }
  const state = await ctx.storageDomain.open(bridgeDomainSpec)
  try {
    lines.push(`state: ${String(state.table('members').size)} paired identities, ${String(state.table('sessions').size)} sessions, ${String(state.table('groups').size)} groups`)
  } finally {
    await state.close()
  }
  return lines
}

/** Execute one maintenance operation and return the lines to print. */
async function execute(ctx: Context, config: Config): Promise<string[]> {
  switch (config.operation) {
    case 'init': return init(ctx, config)
    case 'rotate-key': return rotate(ctx, config)
    case 'status': return status(ctx, config)
    /* v8 ignore next 2 -- run is handled before execute; Loader validation and the closed union exclude the rest */
    default: throw new Error(`chat-runner: unsupported operation ${config.operation}`)
  }
}

/**
 * Mount the runner.
 * @param ctx - plugin context carrying credentials, storage, and the launcher's exit request.
 * @param config - selected operation and Harness home.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.operation === 'run') {
    internals.stdout.write('dsh chat: the bridge is running; stop it with Ctrl-C\n')
    return
  }
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('chat-runner: the launcher must provide ctx.appExit before the tree mounts')
  void execute(ctx, config).then((lines) => {
    for (const line of lines) internals.stdout.write(`${line}\n`)
    exit(0)
  }, (error: unknown) => {
    internals.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}
