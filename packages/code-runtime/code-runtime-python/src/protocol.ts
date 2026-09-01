/**
 * Versionless JSON-lines protocol between the Node host and Python bootstrap.
 * Host frames use stdin and child frames use fd 3; stdout and stderr remain
 * program-log backstops.
 */

/** The framed control channel's descriptor in the child process. */
export const PROTOCOL_FD = 3

interface ErrorClass {
  name: string
  memberNameProperty: string
}

interface Namespace {
  global: string
  names: string[]
  errorClass?: ErrorClass
}

/** Host metadata sent before model source. */
export interface BootMessage {
  type: 'boot'
  cpuSeconds: number
  addressSpaceBytes: number
  maxOutputBytes: number
  maxControlBytes: number
  namespaces: Namespace[]
}

interface RunMessage {
  type: 'run'
  program: string
}

interface BootAckMessage {
  type: 'boot-ack'
}

interface CallMessage {
  type: 'call'
  id: number
  global: string
  name: string
  args: unknown
}

interface LogMessage {
  type: 'log'
  text: string
}

interface DoneErrorField {
  kind: 'exception' | 'invalid-output' | 'output-limit'
  message: string
}

interface DoneMessage {
  type: 'done'
  value?: unknown
  error?: DoneErrorField
}

/** Every rebuilt frame accepted from the Python process. */
export type ChildToHost = BootAckMessage | CallMessage | LogMessage | DoneMessage

interface ReplyOk {
  type: 'reply'
  id: number
  ok: true
  value: unknown
}

interface ReplyErr {
  type: 'reply'
  id: number
  ok: false
  message: string
}

/** Host answer to one binding call. */
export type ReplyMessage = ReplyOk | ReplyErr

/** Host frames sent during one process run. */
export type HostToChild = BootMessage | RunMessage | ReplyMessage

type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T] & string
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T] & string
type FrameFieldRoles<T> = Record<RequiredKeys<T>, 'required'> & Record<OptionalKeys<T>, 'optional'>

interface WireFrameShapes {
  BootMessage: BootMessage
  Namespace: Namespace
  RunMessage: RunMessage
  BootAckMessage: BootAckMessage
  CallMessage: CallMessage
  LogMessage: LogMessage
  DoneErrorField: DoneErrorField
  DoneMessage: DoneMessage
  ErrorClass: ErrorClass
  ReplyOk: ReplyOk
  ReplyErr: ReplyErr
}

type MessageFrames = ChildToHost | ReplyMessage | BootMessage | RunMessage
type RosterMessageFrames = Exclude<WireFrameShapes[keyof WireFrameShapes], Namespace | ErrorClass | DoneErrorField>
type UnionSubsetOfRoster = [MessageFrames] extends [RosterMessageFrames] ? true : false
type RosterSubsetOfUnion = [RosterMessageFrames] extends [MessageFrames] ? true : false
const _unionSubsetOfRoster: UnionSubsetOfRoster = true
const _rosterSubsetOfUnion: RosterSubsetOfUnion = true
void _unionSubsetOfRoster
void _rosterSubsetOfUnion

const WIRE_FRAME_FIELD_ROLES = {
  BootMessage: { type: 'required', cpuSeconds: 'required', addressSpaceBytes: 'required', maxOutputBytes: 'required', maxControlBytes: 'required', namespaces: 'required' },
  Namespace: { global: 'required', names: 'required', errorClass: 'optional' },
  RunMessage: { type: 'required', program: 'required' },
  BootAckMessage: { type: 'required' },
  CallMessage: { type: 'required', id: 'required', global: 'required', name: 'required', args: 'required' },
  LogMessage: { type: 'required', text: 'required' },
  DoneErrorField: { kind: 'required', message: 'required' },
  DoneMessage: { type: 'required', value: 'optional', error: 'optional' },
  ErrorClass: { name: 'required', memberNameProperty: 'required' },
  ReplyOk: { type: 'required', id: 'required', ok: 'required', value: 'required' },
  ReplyErr: { type: 'required', id: 'required', ok: 'required', message: 'required' },
} as const satisfies { [K in keyof WireFrameShapes]: FrameFieldRoles<WireFrameShapes[K]> }

/** Required and optional wire fields, projected for the Python mirror test. */
export const WIRE_FRAME_FIELDS = Object.fromEntries(
  Object.entries(WIRE_FRAME_FIELD_ROLES).map(([frame, roles]) => [
    frame,
    {
      required: Object.keys(roles).filter(key => (roles as Record<string, string>)[key] === 'required').sort(),
      optional: Object.keys(roles).filter(key => (roles as Record<string, string>)[key] === 'optional').sort(),
    },
  ]),
) as Record<keyof typeof WIRE_FRAME_FIELD_ROLES, { required: string[]; optional: string[] }>

/**
 * Encode a JSON-plain value iteratively so deep values do not overflow the host stack.
 * @param value - Value already validated as lossless JSON.
 * @returns Compact JSON text.
 */
export function encodeJsonPlain(value: unknown): string {
  type Task = { text: string } | { value: unknown }
  const chunks: string[] = []
  const tasks: Task[] = [{ value }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if ('text' in task) {
      chunks.push(task.text)
      continue
    }
    const current = task.value
    if (typeof current === 'string') {
      chunks.push(JSON.stringify(current))
    } else if (Array.isArray(current)) {
      chunks.push('[')
      tasks.push({ text: ']' })
      for (let index = current.length - 1; index >= 0; index--) {
        if (index < current.length - 1) tasks.push({ text: ',' })
        tasks.push({ value: current[index] })
      }
    } else if (typeof current === 'object' && current !== null) {
      const record = current as Record<string, unknown>
      const keys = Object.keys(record)
      chunks.push('{')
      tasks.push({ text: '}' })
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index] as string
        if (index < keys.length - 1) tasks.push({ text: ',' })
        tasks.push({ value: record[key] })
        tasks.push({ text: `${JSON.stringify(key)}:` })
      }
    } else if (typeof current === 'number' && Number.isInteger(current) && !Number.isSafeInteger(current)) {
      chunks.push(BigInt(current).toString())
    } else {
      chunks.push(String(current))
    }
  }
  return chunks.join('')
}

/**
 * Detect an integer token that `JSON.parse` would round before validation sees it.
 * @param line - Raw JSON frame text.
 * @returns Whether parsing would lose an integer's value.
 */
export function hasUnsafeIntegerToken(line: string): boolean {
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"') {
      for (index++; index < line.length; index++) {
        if (line[index] === '\\') index++
        else if (line[index] === '"') break
      }
      continue
    }
    if (char !== '-' && (char === undefined || char < '0' || char > '9')) continue
    let end = index + 1
    while (end < line.length) {
      const next = line[end] as string
      if ((next >= '0' && next <= '9') || next === '.' || next === 'e' || next === 'E' || next === '+' || next === '-') end++
      else break
    }
    const token = line.slice(index, end)
    if (/^-?\d+$/.test(token)) {
      const parsed = Number(token)
      if (!Number.isFinite(parsed)) return true
      if (!Number.isSafeInteger(parsed) && BigInt(token) !== BigInt(parsed)) return true
    }
    index = end - 1
  }
  return false
}

/**
 * Detect non-finite numbers and negative zero without recursive traversal.
 * @param value - JSON-parsed value to inspect.
 * @returns Whether the value contains a number outside lossless JSON.
 */
export function hasNonLosslessNumber(value: unknown): boolean {
  const cursors: Iterator<unknown>[] = [[value].values()]
  while (cursors.length > 0) {
    const cursor = cursors.at(-1) as Iterator<unknown>
    const step = cursor.next()
    if (step.done === true) {
      cursors.pop()
      continue
    }
    const current = step.value
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) return true
    } else if (Array.isArray(current)) {
      cursors.push(current.values())
    } else if (typeof current === 'object' && current !== null) {
      cursors.push(ownValues(current))
    }
  }
  return false
}

/** Yield own enumerable values without copying a wide object's value list. */
function* ownValues(value: object): Generator {
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield (value as Record<string, unknown>)[key]
  }
}

/**
 * Validate and rebuild one JSON-parsed child frame. Unknown or malformed frames
 * return `undefined`; no child-owned object crosses this boundary by reference.
 * @param raw - JSON-parsed child frame.
 * @returns A rebuilt known frame, or `undefined` for hostile junk.
 */
export function validateChildFrame(raw: unknown): ChildToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const frame = raw as Record<string, unknown>
  switch (frame.type) {
    case 'boot-ack':
      return { type: 'boot-ack' }
    case 'log':
      return typeof frame.text === 'string' ? { type: 'log', text: frame.text } : undefined
    case 'call':
      if (!Number.isSafeInteger(frame.id) || (frame.id as number) < 0) return undefined
      if (typeof frame.global !== 'string' || typeof frame.name !== 'string' || !Object.hasOwn(frame, 'args')) return undefined
      if (hasNonLosslessNumber(frame.args)) return undefined
      return { type: 'call', id: frame.id as number, global: frame.global, name: frame.name, args: frame.args }
    case 'done': {
      const value = Object.hasOwn(frame, 'value') ? frame.value : undefined
      if (frame.error === undefined) return value === undefined ? { type: 'done' } : { type: 'done', value }
      if (typeof frame.error !== 'object' || frame.error === null) return undefined
      const { kind, message } = frame.error as Record<string, unknown>
      if ((kind !== 'exception' && kind !== 'invalid-output' && kind !== 'output-limit') || typeof message !== 'string') return undefined
      const error: DoneErrorField = { kind, message }
      return value === undefined ? { type: 'done', error } : { type: 'done', value, error }
    }
    default:
      return undefined
  }
}
