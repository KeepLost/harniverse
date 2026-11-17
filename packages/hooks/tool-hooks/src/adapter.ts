/**
 * The generated adapter script plus its idempotent installer. Managed hook
 * commands are stored under a `run` field and invoked through this adapter: it
 * pipes the event payload to the real command, then translates the simple
 * `{ action | context | reason }` stdout contract into the Claude-Code-shaped
 * `hookSpecificOutput` envelope the bridge decodes. The model never sees the
 * envelope; hand-written entries keep running their own commands untouched.
 *
 * The source is a self-contained plain-JavaScript string so the same bytes work
 * from `src/` in development, from `lib/` in a build, and in every deployment:
 * the tool installs it once under the harness home (content-hash guarded) and
 * every managed invocation routes there — file-held entries name their config
 * file and hook on the argv, session-held entries pass the real command inline
 * after `--run`.
 *
 * @module @deepseek-ai/dsh-tool-hooks/adapter
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The adapter script body (plain JavaScript, Node builtins only). */
export const ADAPTER_SOURCE = `import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

function fail(message) {
  console.error('tool-hooks adapter: ' + message)
  process.exit(1)
}

let run
if (process.argv[2] === '--run') {
  run = process.argv[3]
  if (typeof run !== 'string' || run.length === 0) fail('usage: node adapter.mjs --run <command>')
} else {
  const configPath = process.argv[2]
  const hookName = process.argv[3]
  if (typeof configPath !== 'string' || typeof hookName !== 'string') fail('usage: node adapter.mjs <configPath> <hookName> | --run <command>')
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'))
    const map = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.hooks && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks) ? raw.hooks : raw
    const events = map && typeof map === 'object' ? Object.values(map) : []
    search: for (const groups of events) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        if (!group || typeof group !== 'object' || Array.isArray(group) || group.name !== hookName || !Array.isArray(group.hooks)) continue
        for (const hook of group.hooks) {
          if (hook && typeof hook === 'object' && !Array.isArray(hook) && typeof hook.run === 'string') {
            run = hook.run
            break search
          }
        }
      }
    }
    if (run === undefined) fail('no managed hook named ' + hookName + ' in ' + configPath)
  } catch (error) {
    fail('cannot read ' + configPath + ': ' + (error && error.message ? error.message : String(error)))
  }
}

let payload = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (chunk) { payload += chunk })
process.stdin.on('end', function () {
  let eventName
  try {
    const parsed = JSON.parse(payload)
    if (parsed && typeof parsed === 'object' && typeof parsed.hook_event_name === 'string') eventName = parsed.hook_event_name
  } catch (error) { eventName = undefined }
  const child = spawn(run, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', function (chunk) { stdout += chunk })
  child.stdin.on('error', function () { /* the command may exit without reading its stdin; EPIPE is not a hook failure */ })
  child.on('error', function (error) {
    console.error(error && error.message ? error.message : String(error))
    process.exit(1)
  })
  child.on('close', function (code) {
    const trimmed = stdout.trim()
    if (code === 0 && trimmed.startsWith('{')) {
      let structured
      try { structured = JSON.parse(trimmed) } catch (error) { structured = undefined }
      if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
        const specific = {}
        if (typeof eventName === 'string') specific.hookEventName = eventName
        if (structured.action === 'allow' || structured.action === 'deny' || structured.action === 'ask') {
          specific.permissionDecision = structured.action
          if (typeof structured.reason === 'string') specific.permissionDecisionReason = structured.reason
        }
        if (typeof structured.context === 'string') specific.additionalContext = structured.context
        if (specific.permissionDecision !== undefined || specific.additionalContext !== undefined) {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: specific }) + '\\n')
          process.exit(0)
        }
      }
    }
    if (stdout.length > 0) process.stdout.write(stdout)
    process.exit(code === null ? 1 : code)
  })
  child.stdin.write(payload)
  child.stdin.end()
})
`

/** Write the adapter script under the harness home unless the identical bytes are already there.
 * @param adapterPath - absolute destination of the generated adapter script.
 */
export function installAdapter(adapterPath: string): void {
  try {
    if (readFileSync(adapterPath, 'utf8') === ADAPTER_SOURCE) return
  } catch {
    // Absent or unreadable: (re)write below.
  }
  mkdirSync(dirname(adapterPath), { recursive: true })
  writeFileSync(adapterPath, ADAPTER_SOURCE, 'utf8')
}

/** The bridge-visible command that routes one managed hook through the adapter.
 * @param adapterPath - absolute path of the generated adapter script.
 * @param configPath - absolute path of the dialect hook file the adapter reads.
 * @param name - the managed hook's stable name to look up.
 * @returns the shell command the bridge executes.
 */
export function bridgeCommand(adapterPath: string, configPath: string, name: string): string {
  return `node ${shellQuote(adapterPath)} ${shellQuote(configPath)} ${shellQuote(name)}`
}

/** Double-quote one argument for both POSIX shells and Windows cmd/pwsh invocation.
 * @param value - the raw argument to embed in a shell command line.
 * @returns the double-quoted, backslash-escaped argument.
 */
export function shellQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
