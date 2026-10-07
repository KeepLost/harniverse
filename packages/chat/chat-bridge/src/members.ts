/**
 * Bridge configuration and the member whitelist. Deployment choices live in
 * {@link Config}; the closed command vocabulary and every security invariant
 * stay fixed in code. Members are default-deny: a sender acts only after a
 * static `userId` match or a one-time pairing code bound to a listed member.
 * @module @deepseek-ai/dsh-chat-bridge/members
 */

import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Commands an owner can grant to a member one by one. */
export const GRANTABLE_COMMANDS = [
  'new', 'ask', 'stop', 'steer', 'queue', 'unqueue', 'sessions', 'session', 'ws', 'model', 'title', 'compact', 'plan',
] as const

/** A command a member whitelist can grant. */
export type GrantableCommand = (typeof GRANTABLE_COMMANDS)[number]

/** One owner identity. Owners hold every grantable command. */
export interface OwnerConfig {
  /** Platform id of the adapter the owner writes through (`telegram`, `feishu`, ...). */
  platform: string
  /** Platform user id of the owner. */
  userId: string
  /** Agent Profile owner sessions start with; the Harniverse default when omitted. */
  agentProfile?: string
  /** Workspace aliases owner sessions may use; the IM root when empty. */
  workspaces: string[]
}

/** One whitelisted member. */
export interface MemberConfig {
  /** Stable name used by `/invite`, logs, and the IM-root subdirectory. */
  id: string
  /** Platform id of the adapter the member writes through. */
  platform: string
  /** Static identity; when omitted the member joins by a one-time pairing code. */
  userId?: string
  /** Grantable commands the member may use; everything else is refused. */
  commands: GrantableCommand[]
  /** Workspace aliases (keys of `workspaceAliases`) the member may use. */
  workspaces: string[]
  /** Agent Profile every session of this member starts with. */
  agentProfile?: string
  /** Forward all of this member's requests to this remote runtime (lowercase v4 UUID). */
  dshRemoteHost?: string
  /** Whether the member may answer approvals raised by their own sessions. */
  answerOwnApprovals: boolean
}

/** Bridge deployment configuration. */
export interface Config {
  /** Static owner identities; further owners join with the one-time code `dsh chat init` prints. */
  owners: OwnerConfig[]
  /** The member whitelist; a sender outside it (and outside `owners`) is ignored. */
  members: MemberConfig[]
  /** Alias to absolute workspace root; aliases, never paths, appear in chat. */
  workspaceAliases: Record<string, string>
  /** Root for sessions that use no alias; `~` expands to the user's home. */
  imRoot: string
  /** Lifetimes of one-time pairing codes. */
  pairing: {
    /** Lifetime of a member code issued by `/invite`. */
    memberCodeTtlMs: number
    /** Lifetime of an owner code printed by `dsh chat init`. */
    ownerCodeTtlMs: number
  }
  /** Time an approval card waits for an answer before it is rejected. */
  approvalTimeoutMs: number
  /** Time a question card waits for an answer before it is cancelled. */
  questionTimeoutMs: number
  /** Limits on files a user sends to the bot. */
  inbound: {
    /** Files accepted per message. */
    maxFiles: number
    /** Largest accepted file. */
    maxFileBytes: number
    /** Largest image sent inline to the model instead of as a stored attachment. */
    maxInlineImageBytes: number
  }
  /** Limits on files the bridge sends back. */
  outbound: {
    /** Largest file sent back to the chat. */
    maxFileBytes: number
  }
  /** Edit coalescing window for streamed replies. */
  streamIntervalMs: number
  /** Processed inbound message ids retained for duplicate suppression. */
  seenLimit: number
}

/**
 * What a deployment may write for the bridge row: every key that has a schema
 * default is optional, so `Config(input)` and `ctx.plugin(Bridge, Config(input))`
 * accept a partial document and return the fully defaulted {@link Config}.
 */
export interface ConfigInput {
  owners?: Array<Omit<OwnerConfig, 'workspaces'> & { workspaces?: string[] }>
  members?: Array<Omit<MemberConfig, 'commands' | 'workspaces' | 'answerOwnApprovals'> & {
    commands?: GrantableCommand[]
    workspaces?: string[]
    answerOwnApprovals?: boolean
  }>
  workspaceAliases?: Record<string, string>
  imRoot?: string
  pairing?: Partial<Config['pairing']>
  approvalTimeoutMs?: number
  questionTimeoutMs?: number
  inbound?: Partial<Config['inbound']>
  outbound?: Partial<Config['outbound']>
  streamIntervalMs?: number
  seenLimit?: number
}

/** Lifetime of an owner pairing code unless the configuration sets another. */
export const DEFAULT_OWNER_CODE_TTL_MS = 15 * 60_000

const workspaces = z.array(z.string()).default([])

/** Loader validation for the bridge row. */
export const Config: z<ConfigInput, Config> = z.object({
  owners: z.array(z.object({
    platform: z.string().required(),
    userId: z.string().required(),
    agentProfile: z.string(),
    workspaces,
  })).default([]),
  members: z.array(z.object({
    id: z.string().pattern(/^[a-z][a-z0-9_-]{0,31}$/).required(),
    platform: z.string().required(),
    userId: z.string(),
    commands: z.array(z.union(GRANTABLE_COMMANDS.map(command => z.const(command)))).default([]),
    workspaces,
    agentProfile: z.string(),
    dshRemoteHost: z.string(),
    answerOwnApprovals: z.boolean().default(false),
  })).default([]),
  workspaceAliases: z.dict(z.string()).default({}),
  imRoot: z.string().default('~/HarniverseIM'),
  pairing: z.object({
    memberCodeTtlMs: z.number().step(1).min(1).default(24 * 3_600_000),
    ownerCodeTtlMs: z.number().step(1).min(1).default(DEFAULT_OWNER_CODE_TTL_MS),
  }).default({ memberCodeTtlMs: 24 * 3_600_000, ownerCodeTtlMs: DEFAULT_OWNER_CODE_TTL_MS }),
  approvalTimeoutMs: z.number().step(1).min(1).default(10 * 60_000),
  questionTimeoutMs: z.number().step(1).min(1).default(30 * 60_000),
  inbound: z.object({
    maxFiles: z.number().step(1).min(0).default(5),
    maxFileBytes: z.number().step(1).min(1).default(20 * 1024 * 1024),
    maxInlineImageBytes: z.number().step(1).min(1).default(4 * 1024 * 1024),
  }).default({ maxFiles: 5, maxFileBytes: 20 * 1024 * 1024, maxInlineImageBytes: 4 * 1024 * 1024 }),
  outbound: z.object({
    maxFileBytes: z.number().step(1).min(1).default(20 * 1024 * 1024),
  }).default({ maxFileBytes: 20 * 1024 * 1024 }),
  streamIntervalMs: z.number().step(1).min(0).default(800),
  seenLimit: z.number().step(1).min(1).default(2_000),
})

const REMOTE_HOST_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Validate cross-field constraints that a per-field schema cannot express, at
 * the earliest point the configuration is read.
 * @param config - parsed bridge configuration.
 * @throws when an alias is relative, a member names an unknown alias or repeats an id or identity, or a remote host is not a v4 UUID.
 */
export function validateConfig(config: Config): void {
  for (const [alias, root] of Object.entries(config.workspaceAliases)) {
    if (!isAbsolute(root)) throw new Error(`chat-bridge: workspace alias ${JSON.stringify(alias)} must map to an absolute path`)
  }
  const identities = new Set<string>()
  const claim = (platform: string, userId: string): void => {
    const key = identityKey(platform, userId)
    if (identities.has(key)) throw new Error(`chat-bridge: identity ${key} is configured more than once`)
    identities.add(key)
  }
  for (const owner of config.owners) {
    claim(owner.platform, owner.userId)
    checkAliases(config, `owner ${owner.platform}:${owner.userId}`, owner.workspaces)
  }
  const ids = new Set<string>()
  for (const member of config.members) {
    if (ids.has(member.id)) throw new Error(`chat-bridge: member id ${member.id} is configured more than once`)
    ids.add(member.id)
    if (member.userId !== undefined) claim(member.platform, member.userId)
    checkAliases(config, `member ${member.id}`, member.workspaces)
    if (member.dshRemoteHost !== undefined && !REMOTE_HOST_PATTERN.test(member.dshRemoteHost)) {
      throw new Error(`chat-bridge: member ${member.id} dshRemoteHost must be a lowercase v4 UUID`)
    }
  }
}

function checkAliases(config: Config, who: string, aliases: readonly string[]): void {
  for (const alias of aliases) {
    if (!Object.hasOwn(config.workspaceAliases, alias)) {
      throw new Error(`chat-bridge: ${who} names unknown workspace alias ${JSON.stringify(alias)}`)
    }
  }
}

/**
 * Stable key of one platform identity.
 * @param platform - platform id.
 * @param userId - platform user id.
 * @returns the `platform:userId` key.
 */
export function identityKey(platform: string, userId: string): string {
  return `${platform}:${userId}`
}

/** What one authenticated sender may do. */
export interface Actor {
  /** `platform:userId`. */
  key: string
  role: 'owner' | 'member'
  /** Config member id; absent for owners. */
  memberId?: string
  /** Stable label used in logs and the IM-root subdirectory. */
  label: string
  commands: ReadonlySet<string>
  workspaces: readonly string[]
  agentProfile?: string
  remoteHost?: string
  answerOwnApprovals: boolean
}

/**
 * Build the actor for a configured owner.
 * @param owner - owner entry.
 * @returns the owner's actor, holding every grantable command.
 */
export function ownerActor(owner: OwnerConfig): Actor {
  return {
    key: identityKey(owner.platform, owner.userId),
    role: 'owner',
    label: 'owner',
    commands: new Set(GRANTABLE_COMMANDS),
    workspaces: owner.workspaces,
    ...owner.agentProfile === undefined ? {} : { agentProfile: owner.agentProfile },
    answerOwnApprovals: true,
  }
}

/**
 * Build the actor for a configured member bound to an identity.
 * @param member - member entry.
 * @param platform - platform the identity belongs to.
 * @param userId - bound platform user id.
 * @returns the member's actor.
 */
export function memberActor(member: MemberConfig, platform: string, userId: string): Actor {
  return {
    key: identityKey(platform, userId),
    role: 'member',
    memberId: member.id,
    label: member.id,
    commands: new Set(member.commands),
    workspaces: member.workspaces,
    ...member.agentProfile === undefined ? {} : { agentProfile: member.agentProfile },
    ...member.dshRemoteHost === undefined ? {} : { remoteHost: member.dshRemoteHost },
    answerOwnApprovals: member.answerOwnApprovals,
  }
}
