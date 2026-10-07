/**
 * Durable bridge state: pairings, one-time codes, bound groups, conversation
 * bindings, session registry, duplicate-suppression ids, and mux cursors. One
 * storage domain; only the running bridge writes it.
 * @module @deepseek-ai/dsh-chat-bridge/state
 */

import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

/** A paired identity: an owner redeemed by code, or a member bound to a configured member id. */
export const memberBindingSchema = z.object({
  role: z.enum(['owner', 'member']),
  memberId: z.string().optional(),
  /** Display name the identity had when it redeemed an owner code. */
  displayName: z.string().optional(),
  pairedAt: z.number(),
})
/** The stored value type of `memberBindingSchema`. */
export type MemberBinding = z.infer<typeof memberBindingSchema>

/** What redeeming a code grants. */
export const codeRecordSchema = z.object({
  kind: z.enum(['owner', 'member']),
  memberId: z.string().optional(),
  expiresAt: z.number(),
})
/** The stored value type of `codeRecordSchema`. */
export type CodeRecord = z.infer<typeof codeRecordSchema>

/** A group chat an owner bound to the bridge. */
export const groupRecordSchema = z.object({ boundBy: z.string(), boundAt: z.number() })
/** The stored value type of `groupRecordSchema`. */
export type GroupRecord = z.infer<typeof groupRecordSchema>

/** The session a conversation currently talks to, and the workspace alias its next session uses. */
export const bindingRecordSchema = z.object({
  sessionId: z.string().optional(),
  workspace: z.string().optional(),
})
/** The stored value type of `bindingRecordSchema`. */
export type BindingRecord = z.infer<typeof bindingRecordSchema>

/** One session created by the bridge. */
export const sessionRecordSchema = z.object({
  sessionId: z.string(),
  /** `platform:userId` of the creating identity. */
  ownerKey: z.string(),
  botId: z.string(),
  platform: z.string(),
  route: z.object({ kind: z.enum(['direct', 'group']), chatId: z.string(), threadId: z.string().optional() }),
  /** Absolute working directory the session was created with. */
  cwd: z.string(),
  workspace: z.string().optional(),
  remoteHost: z.string().optional(),
  agentProfile: z.string().optional(),
  createdAt: z.number(),
})
/** The stored value type of `sessionRecordSchema`. */
export type BridgeSessionRecord = z.infer<typeof sessionRecordSchema>

/** Durable bridge state domain. */
export const bridgeDomainSpec = defineDomain({
  name: 'chat_bridge',
  version: 1,
  tables: {
    members: domainTable<string, MemberBinding>(memberBindingSchema),
    codes: domainTable<string, CodeRecord>(codeRecordSchema),
    groups: domainTable<string, GroupRecord>(groupRecordSchema),
    bindings: domainTable<string, BindingRecord>(bindingRecordSchema),
    sessions: domainTable<string, BridgeSessionRecord>(sessionRecordSchema),
    seen: domainTable<string, number>(z.number()),
    cursors: domainTable<string, Record<string, number>>(z.record(z.string(), z.number())),
  },
})

/** The opened bridge state domain. */
export type BridgeState = Domain<typeof bridgeDomainSpec>
