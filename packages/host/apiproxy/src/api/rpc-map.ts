/**
 * RPC method registry and signature-derived generics. The map
 * registers only client-request methods (respond is a client-response, so it is absent);
 * map keys are the wire path segments (POST /api/session.list).
 */

import type { SessionsApi } from './sessions.ts'
import type { HostApi } from './host.ts'
import type { WorkspaceApi } from './workspace.ts'
import type { AgentPresetsApi } from './agent-presets.ts'
import type { SkillsApi } from './skills.ts'
import type { GoalsApi } from './goals.ts'
import type { SettingsApi } from './settings.ts'
import type { CredentialsApi } from './credentials.ts'
import type { LlmApi } from './llm.ts'
import type { SubagentsApi } from './subagents.ts'
import type { RpcResponse } from './rpc.ts'
import type { AuthenticationCapability } from '@deepseek-ai/dsh-authentication'

/**
 * Method name → method signature. Signatures are the single source of truth; payload/value
 * types are always derived from here. A method may declare a trailing AbortSignal after the
 * request (command.execute): the carrier passes its request signal, never a wire field.
 */
export interface RpcMethodMap {
  'session.list': SessionsApi['list']
  'session.search': SessionsApi['search']
  'session.create': SessionsApi['create']
  'session.history': SessionsApi['history']
  'session.status': SessionsApi['status']
  'session.workStatus': SessionsApi['workStatus']
  'session.models': SessionsApi['models']
  'session.selectModel': SessionsApi['selectModel']
  'session.rename': SessionsApi['rename']
  'session.fork': SessionsApi['fork']
  'session.prompt': SessionsApi['prompt']
  'session.attachment': SessionsApi['attachment']
  'session.updateQueue': SessionsApi['updateQueue']
  'session.cancel': SessionsApi['cancel']
  'session.close': SessionsApi['close']
  'session.delete': SessionsApi['delete']
  'subagent.list': SubagentsApi['list']
  'subagent.profiles': SubagentsApi['profiles']
  'subagent.history': SubagentsApi['history']
  'subagent.prompt': SubagentsApi['prompt']
  'subagent.interrupt': SubagentsApi['interrupt']
  'host.describe': HostApi['describe']
  'host.pickDirectory': HostApi['pickDirectory']
  'host.listDirectory': HostApi['listDirectory']
  'host.createDirectory': HostApi['createDirectory']
  'host.openPath': HostApi['openPath']
  'workspace.list': WorkspaceApi['list']
  'workspace.create': WorkspaceApi['create']
  'workspace.rename': WorkspaceApi['rename']
  'workspace.delete': WorkspaceApi['delete']
  'workspace.insertBefore': WorkspaceApi['insertBefore']
  'workspace.insertSessionBefore': WorkspaceApi['insertSessionBefore']
  'workspace.archiveSession': WorkspaceApi['archiveSession']
  'workspace.unarchiveSession': WorkspaceApi['unarchiveSession']
  'skill.list': SkillsApi['list']
  'agentPreset.list': AgentPresetsApi['list']
  'agentPreset.read': AgentPresetsApi['read']
  'agentPreset.copy': AgentPresetsApi['copy']
  'agentPreset.openDocument': AgentPresetsApi['openDocument']
  'agentPreset.remove': AgentPresetsApi['remove']
  'goal.create': GoalsApi['create']
  'goal.edit': GoalsApi['edit']
  'goal.pause': GoalsApi['pause']
  'goal.resume': GoalsApi['resume']
  'goal.complete': GoalsApi['complete']
  'goal.clear': GoalsApi['clear']
  'settings.describe': SettingsApi['describe']
  'settings.openDocument': SettingsApi['openDocument']
  'settings.update': SettingsApi['update']
  'settings.replace': SettingsApi['replace']
  'settings.mutate': SettingsApi['mutate']
  'credentials.describe': CredentialsApi['describe']
  'credentials.set': CredentialsApi['set']
  'credentials.unset': CredentialsApi['unset']
  'llm.providers': LlmApi['providers']
  'llm.models': LlmApi['models']
  'llm.discoverModels': LlmApi['discoverModels']
}

/** Required effect capability for every legacy unary endpoint. */
export const RPC_METHOD_CAPABILITIES: { readonly [K in keyof RpcMethodMap]: AuthenticationCapability } = {
  'session.list': 'harniverse.observe',
  'session.search': 'harniverse.observe',
  'session.create': 'harniverse.operate',
  'session.history': 'harniverse.observe',
  'session.status': 'harniverse.observe',
  'session.workStatus': 'harniverse.observe',
  'session.models': 'harniverse.observe',
  'session.selectModel': 'harniverse.operate',
  'session.rename': 'harniverse.operate',
  'session.fork': 'harniverse.operate',
  'session.prompt': 'harniverse.operate',
  'session.attachment': 'harniverse.operate',
  'session.updateQueue': 'harniverse.operate',
  'session.cancel': 'harniverse.operate',
  'session.close': 'harniverse.operate',
  'session.delete': 'harniverse.operate',
  'subagent.list': 'harniverse.observe',
  'subagent.profiles': 'harniverse.observe',
  'subagent.history': 'harniverse.observe',
  'subagent.prompt': 'harniverse.operate',
  'subagent.interrupt': 'harniverse.operate',
  'host.describe': 'harniverse.observe',
  'host.pickDirectory': 'harniverse.administer',
  'host.listDirectory': 'harniverse.administer',
  'host.createDirectory': 'harniverse.administer',
  'host.openPath': 'harniverse.administer',
  'workspace.list': 'harniverse.observe',
  'workspace.create': 'harniverse.operate',
  'workspace.rename': 'harniverse.operate',
  'workspace.delete': 'harniverse.operate',
  'workspace.insertBefore': 'harniverse.operate',
  'workspace.insertSessionBefore': 'harniverse.operate',
  'workspace.archiveSession': 'harniverse.operate',
  'workspace.unarchiveSession': 'harniverse.operate',
  'skill.list': 'harniverse.observe',
  'agentPreset.list': 'harniverse.observe',
  'agentPreset.read': 'harniverse.administer',
  'agentPreset.copy': 'harniverse.administer',
  'agentPreset.openDocument': 'harniverse.administer',
  'agentPreset.remove': 'harniverse.administer',
  'goal.create': 'harniverse.operate',
  'goal.edit': 'harniverse.operate',
  'goal.pause': 'harniverse.operate',
  'goal.resume': 'harniverse.operate',
  'goal.complete': 'harniverse.operate',
  'goal.clear': 'harniverse.operate',
  'settings.describe': 'harniverse.administer',
  'settings.openDocument': 'harniverse.administer',
  'settings.update': 'harniverse.administer',
  'settings.replace': 'harniverse.administer',
  'settings.mutate': 'harniverse.administer',
  'credentials.describe': 'harniverse.administer',
  'credentials.set': 'harniverse.administer',
  'credentials.unset': 'harniverse.administer',
  'llm.providers': 'harniverse.observe',
  'llm.models': 'harniverse.observe',
  'llm.discoverModels': 'harniverse.administer',
}

/** Whether each unary method mutates Host or durable application state. */
export const RPC_METHOD_EFFECTS: { readonly [K in keyof RpcMethodMap]: 'read' | 'mutate' } = {
  'session.list': 'read',
  'session.search': 'read',
  'session.create': 'mutate',
  'session.history': 'read',
  'session.status': 'read',
  'session.workStatus': 'read',
  'session.models': 'read',
  'session.selectModel': 'mutate',
  'session.rename': 'mutate',
  'session.fork': 'mutate',
  'session.prompt': 'mutate',
  'session.attachment': 'read',
  'session.updateQueue': 'mutate',
  'session.cancel': 'mutate',
  'session.close': 'mutate',
  'session.delete': 'mutate',
  'subagent.list': 'read',
  'subagent.profiles': 'read',
  'subagent.history': 'read',
  'subagent.prompt': 'mutate',
  'subagent.interrupt': 'mutate',
  'host.describe': 'read',
  'host.pickDirectory': 'read',
  'host.listDirectory': 'read',
  'host.createDirectory': 'mutate',
  'host.openPath': 'read',
  'workspace.list': 'read',
  'workspace.create': 'mutate',
  'workspace.rename': 'mutate',
  'workspace.delete': 'mutate',
  'workspace.insertBefore': 'mutate',
  'workspace.insertSessionBefore': 'mutate',
  'workspace.archiveSession': 'mutate',
  'workspace.unarchiveSession': 'mutate',
  'skill.list': 'read',
  'agentPreset.list': 'read',
  'agentPreset.read': 'read',
  'agentPreset.copy': 'mutate',
  'agentPreset.openDocument': 'read',
  'agentPreset.remove': 'mutate',
  'goal.create': 'mutate',
  'goal.edit': 'mutate',
  'goal.pause': 'mutate',
  'goal.resume': 'mutate',
  'goal.complete': 'mutate',
  'goal.clear': 'mutate',
  'settings.describe': 'read',
  'settings.openDocument': 'mutate',
  'settings.update': 'mutate',
  'settings.replace': 'mutate',
  'settings.mutate': 'mutate',
  'credentials.describe': 'read',
  'credentials.set': 'mutate',
  'credentials.unset': 'mutate',
  'llm.providers': 'read',
  'llm.models': 'read',
  'llm.discoverModels': 'mutate',
}

/**
 * Test whether one unary method requires an expected-principal precondition.
 * @param method - unary method name.
 * @returns whether the method mutates Host or durable application state.
 */
export function isMutatingRpcMethod(method: keyof RpcMethodMap): boolean {
  return RPC_METHOD_EFFECTS[method] === 'mutate'
}

/**
 * Resolve the required capability for one legacy API endpoint.
 * @param endpoint - channel-relative endpoint.
 * @returns the declared capability, or undefined for an unknown endpoint.
 */
export function legacyRpcCapability(endpoint: string): AuthenticationCapability | undefined {
  if (Object.hasOwn(RPC_METHOD_CAPABILITIES, endpoint)) {
    return RPC_METHOD_CAPABILITIES[endpoint as keyof RpcMethodMap]
  }
  if (endpoint === 'events.mux' || endpoint === 'events.host' || endpoint === 'session.export') {
    return 'harniverse.observe'
  }
  if (endpoint === 'respond') return 'harniverse.operate'
  return undefined
}

/** Business request payload of method K (reaches through the RpcRequest narrow form to payload). */
export type RequestPayload<K extends keyof RpcMethodMap> = Parameters<RpcMethodMap[K]>[0]['payload']

/** Business return value of method K (reaches through the RpcResponse narrow form to infer the ok value of result). */
export type ResponseValue<K extends keyof RpcMethodMap> =
  Awaited<ReturnType<RpcMethodMap[K]>> extends RpcResponse<infer T> ? T : never
