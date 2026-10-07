/**
 * The closed IM command table. Every slash command is listed here; text that
 * starts with `/` and names anything else is refused, never forwarded to the
 * model. There is deliberately no permission, context, export, or generic
 * API command.
 * @module @deepseek-ai/dsh-chat-bridge/commands
 */

import type { Actor } from './members.ts'
import { assertNever } from './never.ts'

/** Who may run a command. */
export type CommandScope = 'pairing' | 'base' | 'grantable' | 'answer' | 'owner'

/** One command row. */
export interface CommandSpec {
  scope: CommandScope
  usage: string
  summary: string
}

/** Every command the bridge understands. */
export const COMMAND_TABLE = {
  pair: { scope: 'pairing', usage: '/pair <code>', summary: 'join with a one-time pairing code' },
  help: { scope: 'base', usage: '/help', summary: 'list the commands you can use' },
  whoami: { scope: 'base', usage: '/whoami', summary: 'show your role and workspace' },
  status: { scope: 'base', usage: '/status', summary: 'show platform and Harniverse connection state' },
  new: { scope: 'grantable', usage: '/new [profile]', summary: 'start a fresh session' },
  ask: { scope: 'grantable', usage: '/ask <text>', summary: 'send a prompt explicitly' },
  stop: { scope: 'grantable', usage: '/stop', summary: 'cancel the running turn' },
  steer: { scope: 'grantable', usage: '/steer <text>', summary: 'redirect the running turn' },
  queue: { scope: 'grantable', usage: '/queue', summary: 'list your queued prompts' },
  unqueue: { scope: 'grantable', usage: '/unqueue [n]', summary: 'remove a queued prompt' },
  sessions: { scope: 'grantable', usage: '/sessions', summary: 'list your sessions' },
  session: { scope: 'grantable', usage: '/session <n>', summary: 'switch this chat to a session' },
  ws: { scope: 'grantable', usage: '/ws [alias]', summary: 'show or pick the workspace for new sessions' },
  model: { scope: 'grantable', usage: '/model [provider/model]', summary: 'show or pick the model' },
  title: { scope: 'grantable', usage: '/title <text>', summary: 'rename the session' },
  compact: { scope: 'grantable', usage: '/compact', summary: 'compact the conversation context' },
  plan: { scope: 'grantable', usage: '/plan [args]', summary: 'enter or leave plan mode' },
  approve: { scope: 'answer', usage: '/approve <id>', summary: 'approve a pending tool request once' },
  reject: { scope: 'answer', usage: '/reject <id>', summary: 'reject a pending tool request' },
  answer: { scope: 'answer', usage: '/answer <id> <answers>', summary: 'answer a pending question' },
  invite: { scope: 'owner', usage: '/invite <member>', summary: 'issue a one-time pairing code for a member' },
  members: { scope: 'owner', usage: '/members', summary: 'list configured members' },
  revoke: { scope: 'owner', usage: '/revoke <member>', summary: 'unbind a paired member' },
  'pair-group': { scope: 'owner', usage: '/pair-group', summary: 'allow the bot in this group chat' },
  'unpair-group': { scope: 'owner', usage: '/unpair-group', summary: 'remove the bot from this group chat' },
} as const satisfies Record<string, CommandSpec>

/** A command name in the closed table. */
export type CommandName = keyof typeof COMMAND_TABLE

/** The parse of one inbound message body. */
export type ParsedInput =
  | { kind: 'text'; text: string }
  | { kind: 'command'; name: CommandName; args: string }
  | { kind: 'unknown'; name: string }

/**
 * Classify a message body. Any text whose first character is `/` is a command invocation.
 * The name is the lowercase first token, so a path-like `/etc/passwd` is an unknown command, never a prompt.
 * @param controlText - the decoration-free body.
 * @returns plain text, a known command with its argument string, or an unknown command.
 */
export function parseInput(controlText: string): ParsedInput {
  const text = controlText.trim()
  if (!text.startsWith('/')) return { kind: 'text', text }
  const gap = text.search(/\s/)
  const name = (gap < 0 ? text.slice(1) : text.slice(1, gap)).toLowerCase()
  if (!Object.hasOwn(COMMAND_TABLE, name)) return { kind: 'unknown', name }
  return { kind: 'command', name: name as CommandName, args: gap < 0 ? '' : text.slice(gap).trim() }
}

/** Why a known command is unavailable to a sender. */
export type Denial = 'not-granted' | 'owner-only' | 'already-paired'

/**
 * Decide whether an identified sender may run a command. `answer` commands are decided per pending request by the caller.
 * @param actor - the sender's actor.
 * @param name - a known command.
 * @returns undefined when allowed, otherwise the reason.
 */
export function authorize(actor: Actor, name: CommandName): Denial | undefined {
  const scope: CommandScope = COMMAND_TABLE[name].scope
  switch (scope) {
    case 'pairing': return 'already-paired'
    case 'base':
    case 'answer': return undefined
    case 'grantable': return actor.commands.has(name) ? undefined : 'not-granted'
    case 'owner': return actor.role === 'owner' ? undefined : 'owner-only'
    /* v8 ignore next 2 -- CommandScope is a closed union */
    default: return assertNever(scope)
  }
}

/**
 * Render the help text for one sender.
 * @param actor - the sender's actor.
 * @returns one line per command the sender may use.
 */
export function helpText(actor: Actor): string {
  const lines = (Object.keys(COMMAND_TABLE) as CommandName[])
    .filter(name => COMMAND_TABLE[name].scope !== 'pairing' && authorize(actor, name) === undefined)
    .map(name => `${COMMAND_TABLE[name].usage} - ${COMMAND_TABLE[name].summary}`)
  return ['Commands you can use:', ...lines, 'Any other message is sent to the assistant.'].join('\n')
}
