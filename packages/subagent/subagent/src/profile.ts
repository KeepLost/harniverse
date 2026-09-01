/** Parent-private Child Profile resolution and its authority boundary. */

import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { ChildProfileGrant, ChildProfileSpec, ResolvedChildProfile } from './types.ts'

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const PROFILE_DIGEST_PATTERN = /^[0-9a-f]{64}$/

function isSupervisionMode(value: unknown): value is 'supervised' | 'unsupervised' {
  return value === 'supervised' || value === 'unsupervised'
}

function assertId(value: string, field: string): void {
  if (!PROFILE_ID_PATTERN.test(value)) throw new Error(`child profile ${field} must be a non-empty opaque id`)
}

function assertUniqueSubset(requested: readonly string[], granted: readonly string[], field: string): string[] {
  const allowed = new Set(granted)
  const result = [...new Set(requested)]
  const denied = result.filter(value => !allowed.has(value))
  if (denied.length > 0) {
    throw new Error(`child profile ${field} requests ids outside the parent grant: ${denied.join(', ')}`)
  }
  return result.sort()
}

function assertSafeInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`child profile ${field} must be a non-negative safe integer`)
  }
}

function childWorkspace(root: string, parentCwd: string, requested: string | undefined): string {
  const workspaceRoot = resolve(root)
  const inherited = resolve(parentCwd)
  if (!isWorkspaceDescendant(workspaceRoot, inherited)) {
    throw new Error('parent workspace cwd must be inside the workspace root')
  }
  if (requested !== undefined && isAbsolute(requested)) {
    throw new Error('child profile workspaceCwd must be relative to the parent workspace')
  }
  const selected = resolve(inherited, requested ?? '.')
  if (!isWorkspaceDescendant(inherited, selected) || !isWorkspaceDescendant(workspaceRoot, selected)) {
    throw new Error('child profile workspaceCwd must remain inside the parent workspace')
  }
  return selected
}

/**
 * Whether `candidate` is equal to or below `root` without prefix confusion.
 * @param root - the containing workspace path.
 * @param candidate - the path to classify.
 * @returns whether `candidate` is equal to or below `root`.
 */
export function isWorkspaceDescendant(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate))
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function freezeProfile(profile: ResolvedChildProfile): ResolvedChildProfile {
  Object.freeze(profile.tools)
  Object.freeze(profile.skills)
  Object.freeze(profile.mcpServerIds)
  Object.freeze(profile.childProfileIds)
  return Object.freeze(profile)
}

function profileDigest(profile: Omit<ResolvedChildProfile, 'digest'> & { readonly digest?: string }): string {
  return createHash('sha256').update(canonicalJson({ ...profile, digest: '' }), 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) throw new Error(`persisted child profile ${key} must be a non-empty string`)
  return field
}

function requiredStringArray(value: Record<string, unknown>, key: string): string[] {
  const field = value[key]
  if (!Array.isArray(field) || field.some(item => typeof item !== 'string')) {
    throw new Error(`persisted child profile ${key} must be an array of strings`)
  }
  return [...new Set(field as string[])]
}

function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const field = value[key]
  if (typeof field !== 'number') throw new Error(`persisted child profile ${key} must be a number`)
  return field
}

/**
 * Validate the detached profile crossing a provider or persistence boundary.
 * @param profile - the profile snapshot to validate.
 */
export function assertResolvedChildProfile(profile: ResolvedChildProfile): void {
  assertId(profile.profileId, 'profileId')
  assertId(profile.harnessId, 'harnessId')
  assertId(profile.modelRouteId, 'modelRouteId')
  if (!isAbsolute(profile.workspaceCwd)) throw new Error('child profile workspaceCwd must be absolute')
  assertSafeInteger(profile.revision, 'revision')
  if (profile.revision === 0) throw new Error('child profile revision must be greater than zero')
  if (!PROFILE_DIGEST_PATTERN.test(profile.digest) || profileDigest(profile) !== profile.digest) {
    throw new Error('child profile digest does not match its immutable contents')
  }
  for (const [field, values] of Object.entries({
    tools: profile.tools,
    skills: profile.skills,
    mcpServerIds: profile.mcpServerIds,
    childProfileIds: profile.childProfileIds,
  })) {
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
      throw new Error(`child profile ${field} must be an array of strings`)
    }
  }
  assertSafeInteger(profile.maxDepth, 'maxDepth')
  assertSafeInteger(profile.maxTokens, 'maxTokens')
  assertSafeInteger(profile.modelRoutePriority, 'modelRoutePriority')
  assertSafeInteger(profile.schedulerPriority, 'schedulerPriority')
  if (profile.supervisionMode !== undefined && !isSupervisionMode(profile.supervisionMode)) {
    throw new Error('child profile supervisionMode must be "supervised" or "unsupervised"')
  }
}

/**
 * Combine a profile's tool grant with an optional narrower per-start filter.
 * @param profile - the immutable profile grant.
 * @param requested - the optional narrower request.
 * @returns the effective tool restriction.
 */
export function childProfileToolFilter(
  profile: ResolvedChildProfile,
  requested: ToolRestriction | undefined,
): ToolRestriction {
  const granted = new Set(profile.tools)
  if (requested?.allow !== undefined) {
    const outside = requested.allow.filter(name => !granted.has(name))
    if (outside.length > 0) throw new Error(`child toolFilter requests tools outside child profile: ${outside.join(', ')}`)
  }
  return {
    allow: requested?.allow === undefined ? profile.tools : [...new Set(requested.allow)].sort(),
    ...requested?.deny !== undefined ? { deny: requested.deny } : {},
  }
}

/**
 * Parse and validate a persisted resolved profile snapshot.
 * @param value - the untrusted persisted value.
 * @returns the validated immutable profile.
 */
export function parseResolvedChildProfile(value: unknown): ResolvedChildProfile {
  if (!isRecord(value)) throw new Error('persisted child profile must be an object')
  const allowed = new Set([
    'profileId', 'revision', 'digest', 'harnessId', 'modelRouteId', 'tools', 'skills',
    'mcpServerIds', 'childProfileIds', 'workspaceCwd', 'maxDepth', 'maxTokens',
    'modelRoutePriority', 'schedulerPriority',
    'supervisionMode',
  ])
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown !== undefined) throw new Error(`persisted child profile has unknown field "${unknown}"`)
  const profile = {
    profileId: requiredString(value, 'profileId'),
    revision: value['revision'],
    digest: requiredString(value, 'digest'),
    harnessId: requiredString(value, 'harnessId'),
    modelRouteId: requiredString(value, 'modelRouteId'),
    tools: requiredStringArray(value, 'tools'),
    skills: requiredStringArray(value, 'skills'),
    mcpServerIds: requiredStringArray(value, 'mcpServerIds'),
    childProfileIds: requiredStringArray(value, 'childProfileIds'),
    workspaceCwd: requiredString(value, 'workspaceCwd'),
    ...optionalNumber(value, 'maxDepth') !== undefined ? { maxDepth: optionalNumber(value, 'maxDepth') } : {},
    ...optionalNumber(value, 'maxTokens') !== undefined ? { maxTokens: optionalNumber(value, 'maxTokens') } : {},
    ...optionalNumber(value, 'modelRoutePriority') !== undefined ? { modelRoutePriority: optionalNumber(value, 'modelRoutePriority') } : {},
    ...optionalNumber(value, 'schedulerPriority') !== undefined ? { schedulerPriority: optionalNumber(value, 'schedulerPriority') } : {},
    ...value['supervisionMode'] !== undefined ? { supervisionMode: value['supervisionMode'] } : {},
  } as unknown as ResolvedChildProfile
  if (typeof profile.revision !== 'number') throw new Error('persisted child profile revision must be a number')
  if (profile.supervisionMode !== undefined && !isSupervisionMode(profile.supervisionMode)) {
    throw new Error('persisted child profile supervisionMode must be "supervised" or "unsupervised"')
  }
  assertResolvedChildProfile(profile)
  return freezeProfile(profile)
}

/**
 * Resolve a requested profile against the parent grant without silently
 * clipping it. The returned object is detached and immutable for cold resume.
 * @param spec - the requested child profile.
 * @param grant - the parent's granted capabilities and bounds.
 * @param revision - the positive profile revision to persist.
 * @returns the resolved immutable profile.
 */
export function resolveChildProfile(
  spec: ChildProfileSpec,
  grant: ChildProfileGrant,
  revision: number,
): ResolvedChildProfile {
  assertId(spec.profileId, 'profileId')
  assertId(spec.harnessId, 'harnessId')
  assertId(spec.modelRouteId, 'modelRouteId')
  assertSafeInteger(revision, 'revision')
  if (revision === 0) throw new Error('child profile revision must be greater than zero')
  if (!grant.harnessIds.includes(spec.harnessId)) throw new Error(`child profile harnessId is not granted: ${spec.harnessId}`)
  if (!grant.modelRouteIds.includes(spec.modelRouteId)) throw new Error(`child profile modelRouteId is not granted: ${spec.modelRouteId}`)
  assertSafeInteger(spec.maxDepth, 'maxDepth')
  assertSafeInteger(spec.maxTokens, 'maxTokens')
  if (spec.maxDepth !== undefined && grant.maxDepth !== undefined && spec.maxDepth > grant.maxDepth) {
    throw new Error('child profile maxDepth exceeds the parent grant')
  }
  if (spec.maxTokens !== undefined && grant.maxTokens !== undefined && spec.maxTokens > grant.maxTokens) {
    throw new Error('child profile maxTokens exceeds the parent grant')
  }
  assertSafeInteger(spec.modelRoutePriority, 'modelRoutePriority')
  assertSafeInteger(spec.schedulerPriority, 'schedulerPriority')
  if (spec.supervisionMode !== undefined && !isSupervisionMode(spec.supervisionMode)) {
    throw new Error('child profile supervisionMode must be "supervised" or "unsupervised"')
  }

  const profile: ResolvedChildProfile = {
    profileId: spec.profileId,
    revision,
    digest: '',
    harnessId: spec.harnessId,
    modelRouteId: spec.modelRouteId,
    tools: assertUniqueSubset(spec.tools ?? grant.tools, grant.tools, 'tools'),
    skills: assertUniqueSubset(spec.skills ?? grant.skills, grant.skills, 'skills'),
    mcpServerIds: assertUniqueSubset(spec.mcpServerIds ?? grant.mcpServerIds, grant.mcpServerIds, 'mcpServerIds'),
    childProfileIds: assertUniqueSubset(spec.childProfileIds ?? grant.childProfileIds, grant.childProfileIds, 'childProfileIds'),
    workspaceCwd: childWorkspace(grant.workspaceRoot, grant.parentWorkspaceCwd, spec.workspaceCwd),
    ...spec.maxDepth !== undefined || grant.maxDepth !== undefined
      ? { maxDepth: spec.maxDepth ?? grant.maxDepth }
      : {},
    ...spec.maxTokens !== undefined || grant.maxTokens !== undefined
      ? { maxTokens: spec.maxTokens ?? grant.maxTokens }
      : {},
    ...spec.modelRoutePriority !== undefined ? { modelRoutePriority: spec.modelRoutePriority } : {},
    ...spec.schedulerPriority !== undefined ? { schedulerPriority: spec.schedulerPriority } : {},
    ...spec.supervisionMode !== undefined ? { supervisionMode: spec.supervisionMode } : {},
  }
  const digest = profileDigest(profile)
  return freezeProfile({ ...profile, digest })
}
