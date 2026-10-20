/** Durable sound-notification preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the sound notification plugin. */
export const SOUND_SETTINGS_NAMESPACE = 'ui-sound'

/** Synthesized built-in sounds selectable per event. */
export const BUILTIN_SOUND_KEYS = ['ding', 'chime', 'bell', 'complete', 'success'] as const

/** One synthesized built-in sound. */
export type BuiltinSoundKey = typeof BUILTIN_SOUND_KEYS[number]

/** The six independently configured notification events. */
export const SOUND_EVENT_KINDS = ['completion', 'approval', 'question', 'plan-review', 'goal-blocked', 'failure'] as const

/** One independently configured notification event. */
export type SoundEventKind = typeof SOUND_EVENT_KINDS[number]

/** The two routing channels: the main agent and subagent-originated events. */
export const SOUND_CHANNELS = ['main', 'subagent'] as const

/** One routing channel for a notification event. */
export type SoundChannel = typeof SOUND_CHANNELS[number]

/**
 * Values one event's sound field accepts: a built-in key, `none` (mute),
 * `local` (a file is expected but none is chosen), or an `audio:<id>`
 * reference into the browser's IndexedDB audio library.
 */
export const SOUND_VALUE_PATTERN = /^(?:ding|chime|bell|complete|success|none|local|audio:[a-z0-9]+)$/u

/** Lower-camel field stem of one event kind. */
const FIELD_STEMS = {
  completion: 'completion',
  approval: 'approval',
  question: 'question',
  'plan-review': 'planReview',
  'goal-blocked': 'goalBlocked',
  failure: 'failure',
} as const satisfies Record<SoundEventKind, string>

/**
 * Sound field name of one event kind on one channel.
 * @param kind - the event kind whose sound field is named.
 * @param channel - the channel (main agent or subagent) the field belongs to.
 * @returns the settings field name holding that channel's sound for the kind.
 */
export function soundFieldFor(kind: SoundEventKind, channel: SoundChannel): string {
  const stem = FIELD_STEMS[kind]
  const upper = stem.charAt(0).toUpperCase() + stem.slice(1)
  return `${channel === 'subagent' ? `subagent${upper}` : stem}Sound`
}

/**
 * Volume field name of one event kind on one channel.
 * @param kind - the event kind whose volume field is named.
 * @param channel - the channel (main agent or subagent) the field belongs to.
 * @returns the settings field name holding that channel's volume for the kind.
 */
export function volumeFieldFor(kind: SoundEventKind, channel: SoundChannel): string {
  return `${soundFieldFor(kind, channel).slice(0, -'Sound'.length)}Volume`
}

/** Default sound of one event kind on one channel. */
export const DEFAULT_SOUND_FOR: Record<SoundChannel, Record<SoundEventKind, string>> = {
  main: {
    completion: 'chime',
    approval: 'ding',
    question: 'ding',
    'plan-review': 'ding',
    'goal-blocked': 'ding',
    failure: 'bell',
  },
  subagent: {
    completion: 'none',
    approval: 'ding',
    question: 'ding',
    'plan-review': 'ding',
    'goal-blocked': 'bell',
    failure: 'bell',
  },
}

/** Durable sound section shared by the Host schema and the browser scope. */
export interface SoundSettings {
  /** Master switch; no sound plays while false. */
  enabled: boolean
  /** Skip the completion sound for the session currently being viewed. */
  quietCurrent: boolean
  /** Ignore every subagent-originated event. */
  ignoreSubagent: boolean
  /** Sound values per event kind (main channel). */
  completionSound: string
  approvalSound: string
  questionSound: string
  planReviewSound: string
  goalBlockedSound: string
  failureSound: string
  /** Volumes (0–1) per event kind (main channel). */
  completionVolume: number
  approvalVolume: number
  questionVolume: number
  planReviewVolume: number
  goalBlockedVolume: number
  failureVolume: number
  /** Sound values per event kind (subagent channel). */
  subagentCompletionSound: string
  subagentApprovalSound: string
  subagentQuestionSound: string
  subagentPlanReviewSound: string
  subagentGoalBlockedSound: string
  subagentFailureSound: string
  /** Volumes (0–1) per event kind (subagent channel). */
  subagentCompletionVolume: number
  subagentApprovalVolume: number
  subagentQuestionVolume: number
  subagentPlanReviewVolume: number
  subagentGoalBlockedVolume: number
  subagentFailureVolume: number
}

/**
 * The complete default section.
 * @returns a fresh section value with every field at its default.
 */
export function defaultSoundSettings(): SoundSettings {
  const section = {
    enabled: true,
    quietCurrent: false,
    ignoreSubagent: false,
  } as SoundSettings
  for (const channel of SOUND_CHANNELS) {
    for (const kind of SOUND_EVENT_KINDS) {
      Reflect.set(section, soundFieldFor(kind, channel), DEFAULT_SOUND_FOR[channel][kind])
      Reflect.set(section, volumeFieldFor(kind, channel), 1)
    }
  }
  return section
}

/** Build one sound field's schema node. */
const soundField = (kind: SoundEventKind, channel: SoundChannel): z<string> =>
  z.string().pattern(SOUND_VALUE_PATTERN).default(DEFAULT_SOUND_FOR[channel][kind])

/** Build one volume field's schema node. */
const volumeField = (): z<number> => z.number().min(0).max(1).default(1)

/** Durable sound schema; also the wire envelope the browser scope validates against. */
export const SoundSettingsSchema: z<SoundSettings> = z.object({
  enabled: z.boolean().default(true),
  quietCurrent: z.boolean().default(false),
  ignoreSubagent: z.boolean().default(false),
  completionSound: soundField('completion', 'main'),
  approvalSound: soundField('approval', 'main'),
  questionSound: soundField('question', 'main'),
  planReviewSound: soundField('plan-review', 'main'),
  goalBlockedSound: soundField('goal-blocked', 'main'),
  failureSound: soundField('failure', 'main'),
  completionVolume: volumeField(),
  approvalVolume: volumeField(),
  questionVolume: volumeField(),
  planReviewVolume: volumeField(),
  goalBlockedVolume: volumeField(),
  failureVolume: volumeField(),
  subagentCompletionSound: soundField('completion', 'subagent'),
  subagentApprovalSound: soundField('approval', 'subagent'),
  subagentQuestionSound: soundField('question', 'subagent'),
  subagentPlanReviewSound: soundField('plan-review', 'subagent'),
  subagentGoalBlockedSound: soundField('goal-blocked', 'subagent'),
  subagentFailureSound: soundField('failure', 'subagent'),
  subagentCompletionVolume: volumeField(),
  subagentApprovalVolume: volumeField(),
  subagentQuestionVolume: volumeField(),
  subagentPlanReviewVolume: volumeField(),
  subagentGoalBlockedVolume: volumeField(),
  subagentFailureVolume: volumeField(),
})

/**
 * Resolve one raw section through the schema: defaults filled, invalid input throws.
 * @param section - the raw settings section value to resolve.
 * @returns the section with defaults filled; throws on invalid input.
 */
export function resolveSoundSettings(section: unknown): SoundSettings {
  return SoundSettingsSchema(section as never)
}

/**
 * Narrow one wire section into a complete sound settings value: known fields
 * validate against their pattern or range, anything unknown or malformed
 * falls back to its default, and a non-object input yields undefined (the
 * scope keeps its last accepted value instead).
 *
 * @param section - the raw namespace section as stored.
 * @returns the complete settings value, or undefined for non-object input.
 */
export function decodeSoundSettings(section: unknown): SoundSettings | undefined {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return undefined
  const source = section as Record<string, unknown>
  const out = defaultSoundSettings()
  if (typeof source.enabled === 'boolean') out.enabled = source.enabled
  if (typeof source.quietCurrent === 'boolean') out.quietCurrent = source.quietCurrent
  if (typeof source.ignoreSubagent === 'boolean') out.ignoreSubagent = source.ignoreSubagent
  for (const channel of SOUND_CHANNELS) {
    for (const kind of SOUND_EVENT_KINDS) {
      const soundField = soundFieldFor(kind, channel)
      const volumeField = volumeFieldFor(kind, channel)
      const sound = source[soundField]
      if (typeof sound === 'string' && SOUND_VALUE_PATTERN.test(sound)) Reflect.set(out, soundField, sound)
      const volume = source[volumeField]
      if (typeof volume === 'number' && Number.isFinite(volume)) {
        Reflect.set(out, volumeField, Math.min(Math.max(volume, 0), 1))
      }
    }
  }
  return out
}
