/** Cross-platform native single-directory chooser behind the native backend's capability. */

import { existsSync } from 'node:fs'
import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { DIALOG_TITLE, pickWin32Dialog } from './win32-dialog.ts'
import type { Win32DialogInternals } from './win32-dialog.ts'

/** Testable command boundary; native implementations never invoke a shell. */
export type DirectoryPickerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface DirectoryPickerInternals {
  platform?: NodeJS.Platform
  run?: DirectoryPickerRunner
  /** Replaces the in-process Win32 dialog (`pickWin32Dialog`) for deterministic tests. */
  pickWin32Dialog?: (signal: AbortSignal, request: Win32DialogRequest, internals?: Win32DialogInternals) => Promise<string | null>
}

/** The file-chooser title used when a request omits one. */
export const FILE_PICKER_TITLE = 'Select File'

/** A native single-file selection request as the adapters consume it. */
export interface NativeFileRequest {
  title?: string
  defaultDirectory?: string
}

/** The Win32 dialog request shape this module forwards (`win32-dialog.ts`). */
export type Win32DialogRequest = { title: string; mode: 'directory' | 'file'; defaultDirectory?: string }

/** Double-quote an AppleScript string literal (backslash and quote). */
function applescriptString(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function errorStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return ''
  const stderr = (error as { stderr?: unknown }).stderr
  return typeof stderr === 'string' ? stderr : ''
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function rethrowIfAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error
}

/**
 * Open the platform directory picker.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - Platform and runner hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 */
export async function pickNativeDirectory(
  signal: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    try {
      const result = await run('osascript', [
        '-e', 'set selectedFolder to choose folder with prompt "Select Workspace Directory"',
        '-e', 'POSIX path of selectedFolder',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      if (!signal.aborted && errorCode(error) === 1
        && /(?:User canceled|-128)/i.test(errorStderr(error))) return null
      throw error
    }
  }

  if (platform === 'win32') {
    // The koffi-backed IFileOpenDialog child process — the modern picker with
    // per-monitor-v2 DPI and abort support. koffi is a packaged dependency
    // whose availability the install guarantees, so there is no fallback
    // tier: any failure surfaces as-is (no PowerShell fallback tier; see
    // .agents/notes/implemented/simplification/2026-08-04-drop-windows-powershell-picker-fallback.md).
    const pickDialog = internals.pickWin32Dialog ?? pickWin32Dialog
    return await pickDialog(signal, { title: DIALOG_TITLE, mode: 'directory' })
  }

  if (platform === 'linux') {
    try {
      const result = await run('zenity', [
        '--file-selection', '--directory', '--title=Select Workspace Directory',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
    }

    try {
      const result = await run('kdialog', [
        '--getexistingdirectory', '.', '--title', 'Select Workspace Directory',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (isMissingCommand(error)) {
        throw new Error('no supported native directory picker found (install zenity or kdialog)')
      }
      throw error
    }
  }

  throw new Error(`native directory picker is unsupported on ${platform}`)
}

/**
 * Open the platform single-file picker.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param request - optional dialog title and starting directory.
 * @param internals - Platform and runner hooks for deterministic tests.
 * @returns the selected file path, or null when the user cancels.
 */
export async function pickNativeFile(
  signal: AbortSignal,
  request: NativeFileRequest = {},
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand
  const title = request.title ?? FILE_PICKER_TITLE
  // A start directory the host cannot see would hard-fail osascript and seed
  // the other choosers with a dead path; drop it instead.
  const start = request.defaultDirectory !== undefined && existsSync(request.defaultDirectory) ? request.defaultDirectory : undefined

  if (platform === 'darwin') {
    try {
      const result = await run('osascript', [
        '-e', `set selectedFile to choose file with prompt ${applescriptString(title)}${start === undefined ? '' : ` default location (POSIX file ${applescriptString(start)})`}`,
        '-e', 'POSIX path of selectedFile',
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      if (!signal.aborted && errorCode(error) === 1
        && /(?:User canceled|-128)/i.test(errorStderr(error))) return null
      throw error
    }
  }

  if (platform === 'win32') {
    const pickDialog = internals.pickWin32Dialog ?? pickWin32Dialog
    return await pickDialog(signal, { title, mode: 'file', ...(start === undefined ? {} : { defaultDirectory: start }) })
  }

  if (platform === 'linux') {
    try {
      const result = await run('zenity', [
        '--file-selection', `--title=${title}`,
        ...(start === undefined ? [] : [`--filename=${start}/`]),
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
    }

    try {
      const result = await run('kdialog', [
        '--getopenfilename', start ?? '.', '*',
        '--title', title,
      ], signal)
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (isMissingCommand(error)) {
        throw new Error('no supported native file picker found (install zenity or kdialog)')
      }
      throw error
    }
  }

  throw new Error(`native file picker is unsupported on ${platform}`)
}
