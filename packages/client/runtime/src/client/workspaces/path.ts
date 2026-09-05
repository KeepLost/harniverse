/** Whether a path uses a Windows drive or UNC prefix. */
function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
}

/**
 * Resolve a workspace-relative path into the Host-facing spelling used by openPath.
 * @param cwd - session workspace root, when known.
 * @param path - absolute or workspace-relative path.
 * @returns an absolute path when a workspace root is available, otherwise the original path.
 */
export function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (path.startsWith('/') || isWindowsStylePath(path)) return path
  if (cwd === undefined || cwd === '') return path
  const separator = isWindowsStylePath(cwd) && cwd.includes('\\') ? '\\' : '/'
  const base = cwd.replace(/[/\\]+$/, '')
  const rel = path.replace(/^[/\\]+/, '')
  return `${base}${separator}${rel}`
}
