/** Official-layout session roots for the discovery and import specs. */

import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

export { FOREIGN_TEXT, officialArtifact } from '../../../session/session-import/tests/import-fixture.ts'

/** Encode a log as official builds do: the header frame, then one frame per batch. */
export function zstdLog(text: string): Buffer {
  const split = text.indexOf('\n') + 1
  return Buffer.concat([zstdCompressSync(Buffer.from(text.slice(0, split))), zstdCompressSync(Buffer.from(text.slice(split)))])
}

/** A fresh canonical temp directory (macOS tmpdir sits behind a symlink). */
export async function tempRoot(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)))
}

/**
 * Write one official log at `<root>/<project>/<session>/<file>`.
 * @returns the log's absolute path.
 */
export async function writeOfficialLog(
  root: string, project: string, session: string, file: string, content: string | Buffer,
): Promise<string> {
  const dir = join(root, project, session)
  await mkdir(dir, { recursive: true })
  const path = join(dir, file)
  await writeFile(path, content)
  return path
}

/** Rewrite a foreign log's header fields; an undefined value removes the field. */
export function withHeader(text: string, patch: Record<string, unknown>): string {
  const [header, ...rest] = text.split('\n')
  const merged = { ...JSON.parse(header as string) as Record<string, unknown>, ...patch }
  const kept = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined))
  return [JSON.stringify(kept), ...rest].join('\n')
}
