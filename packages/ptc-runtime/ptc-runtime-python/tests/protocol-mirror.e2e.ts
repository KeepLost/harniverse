import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { PROTOCOL_FD, WIRE_FRAME_FIELDS } from '../src/protocol.ts'

const execFileAsync = promisify(execFile)
const pyDir = fileURLToPath(new URL('../py', import.meta.url))

async function hasPython3(): Promise<boolean> {
  try {
    await execFileAsync('python3', ['-c', 'import sys; raise SystemExit(sys.version_info < (3, 10))'])
    return true
  } catch {
    return false
  }
}

const python3Available = await hasPython3()

describe.skipIf(!python3Available)('Python protocol mirror (real python3)', () => {
  it('matches the fd and every required/optional field set', async () => {
    const probe = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
      'import protocol as p',
      'def keys(td): return {"required": sorted(td.__required_keys__), "optional": sorted(td.__optional_keys__)}',
      'frames = {n: keys(v) for n, v in vars(p).items() if not n.startswith("_") and hasattr(v, "__required_keys__")}',
      'print(json.dumps({"fd": p.PROTOCOL_FD, "frames": frames}))',
    ].join('\n')
    const { stdout } = await execFileAsync('python3', ['-I', '-B', '-c', probe])
    const seen = JSON.parse(stdout) as { fd: number; frames: typeof WIRE_FRAME_FIELDS }
    expect(seen.fd).toBe(PROTOCOL_FD)
    expect(seen.frames).toEqual(WIRE_FRAME_FIELDS)
  })
})
