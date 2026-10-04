/**
 * Pure helpers for the desktop drop/paste intake (X13-R31): the shell bridge
 * that names a browser File's Host path, plus the workspace-path projections
 * a `@path` reference chip is built from. No React, DOM listeners, or cordis.
 */

/**
 * Browser-shell bridge reporting the harness-host path of a dropped or pasted
 * file. The Desktop preload exposes it on the application document (Electron
 * `webUtils.getPathForFile`); a served Web page has none, so every file there
 * uploads and folders are refused.
 */
export interface HostPathBridge {
  /** Absolute harness-host path of one picked file, or empty when the shell has none for it. */
  pathFor(file: File): string
}

/**
 * The shell-installed bridge, when this document runs inside the Desktop application.
 * @returns the Desktop shell's path bridge, or `undefined` on a served Web page.
 */
export function hostPathBridge(): HostPathBridge | undefined {
  return (globalThis as { harniverseHostPaths?: HostPathBridge }).harniverseHostPaths
}

/**
 * Strip the workspace root from a workspace-rooted absolute path (display and
 * mention form; the session cwd is the root).
 * @param text - the path to shorten.
 * @param cwd - session workspace root; absent or empty leaves the path unchanged.
 * @returns the path relative to the workspace root, or unchanged when it is not rooted there.
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

/**
 * Read the final non-empty segment of a Workspace path for display.
 * @param path - Workspace directory path using POSIX or Windows separators.
 * @returns the final segment, or an empty string for a separator-only path.
 */
export function workspaceTitleOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}

/**
 * Format one path as the `@path` mention grammar (a directory path arrives
 * with its trailing separator already present, so the quote closes and the
 * chip reads as complete rather than a drill-in progress).
 * @param path - workspace-relative path, trailing `/` included for directories.
 * @returns the mention text, or undefined for a path the grammar cannot
 * represent safely (control characters or an embedded double quote).
 */
export function formatFileMention(path: string): string | undefined {
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  if (!/\s/u.test(path)) return `@${path}`
  return `@"${path}"`
}
