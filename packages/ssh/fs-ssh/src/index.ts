/** Remote filesystem provider; target identities and all paths belong to the execution machine. */
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileSystem, FsError } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-ssh'
import { RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { editResultSchema, entriesSchema, infoSchema, pathInfoSchema, targetSchema, writeResultSchema } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'

/** Serves the `FileSystem` seam over the SSH execution world's bounded RPC. */
export class SshFileSystem extends FileSystem {
  static inject = ['ssh', 'sandboxPolicy']
  override get sandboxMode(): SandboxMode { return this.ctx.sandboxPolicy.defaultMode }
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return await this.call('fs.resolve', { path, cwd: opts?.cwd }, targetSchema, opts?.signal) as FsTarget
  }
  override processPath(target: FsTarget): string { return String(target.targetKey) }
  override fileUrl(target: FsTarget): string { return pathToFileURL(this.processPath(target)).href }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = posix.relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith('../') && !posix.isAbsolute(path))
  }
  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return (await this.call('fs.stat', { target }, infoSchema.nullable(), signal) as FsInfo | null) ?? undefined
  }
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return (await this.call('fs.lstat', { path, cwd: opts?.cwd }, pathInfoSchema.nullable(), signal) as FsPathInfo | null) ?? undefined
  }
  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    let result = ''
    for await (const chunk of await this.streamText(target, signal)) {
      result += chunk
      if (Buffer.byteLength(result) > 8 * 1024 * 1024) throw new FsError('SSH text exceeds 8 MiB; use streaming', 'FS_TOO_LARGE')
    }
    return result
  }
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const id = await this.call('fs.stream', { target }, z.uuid(), signal)
    const call = this.call.bind(this)
    return (async function* () {
      let ended = false
      try {
        while (!ended) {
          const next = await call('fs.next', { id }, z.object({ done: z.boolean(), value: z.string() }).strict(), signal)
          ended = next.done
          if (next.value.length > 0) yield next.value
        }
      } finally {
        if (!ended) await call('fs.streamClose', { id }, z.null()).catch(() => {})
      }
    })()
  }
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return Buffer.from(await this.call('fs.readBytes', { target, maxBytes: Math.min(maxBytes, 512 * 1024) }, z.base64(), signal), 'base64')
  }
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return await this.call('fs.list', { target }, entriesSchema, signal) as FsDirEntry[]
  }
  /**
   * Write text through the remote backend under the machine-resolved policy.
   * @param target - resolved remote target.
   * @param content - the full new text.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts the remote request; a completed remote write is not rolled back.
   * @param policy - the per-call sandbox policy; omit to use the machine's resolved default.
   * @returns the write outcome from the remote backend.
   */
  override async writeText(
    target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, policy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return await this.call('fs.write', { target, content, expected, policy: policy ?? this.ctx.sandboxPolicy.resolve() }, writeResultSchema, signal) as FsWriteOutcome
  }

  /**
   * Apply an in-place edit through the remote backend under the machine-resolved policy.
   * @param target - resolved remote target.
   * @param edit - the old/new strings and replaceAll selection.
   * @param expected - the version guard for the edit; omit for unconditional.
   * @param signal - aborts the remote request; a completed remote edit is not rolled back.
   * @param policy - the per-call sandbox policy; omit to use the machine's resolved default.
   * @returns the edit outcome from the remote backend.
   */
  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return await this.call('fs.edit', { target, edit, expected, policy: policy ?? this.ctx.sandboxPolicy.resolve() }, editResultSchema, signal) as FsEditOutcome
  }
  private async call<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    try { return await this.ctx.ssh.request(method, params, schema, signal) }
    catch (error) {
      if (error instanceof RemoteOperationError && error.code?.startsWith('FS_')) throw new FsError(error.message, error.code as FsErrorCode, { cause: error })
      throw new FsError(error instanceof Error ? error.message : String(error), signal?.aborted ? 'FS_ABORTED' : 'FS_IO_ERROR', { cause: error })
    }
  }
}
export default SshFileSystem
