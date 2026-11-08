/**
 * Browser-safe Workspace path and display helpers.
 * @module @deepseek-ai/dsh-util-workspace-path
 */
/**
 * Whether a path is absolute in either spelling the Host accepts: POSIX (`/a/b`) or Windows drive or UNC.
 * @param path - the path to classify.
 * @returns `true` for an absolute path; `false` for a Workspace-relative one.
 */
export declare function isAbsoluteWorkspacePath(path: string): boolean
/**
 * Strip the workspace root from a workspace-rooted absolute path (display only).
 * @param text - the path to shorten.
 * @param cwd - session workspace root; absent or empty leaves the path unchanged.
 * @returns the path relative to the workspace root, or unchanged when it is not rooted there.
 */
export declare function relativizeToCwd(text: string, cwd: string | undefined): string
/**
 * Read the final non-empty segment of a Workspace path for display.
 * @param path - Workspace directory path using POSIX or Windows separators.
 * @returns the final segment, or an empty string for a separator-only path.
 */
export declare function workspaceTitleOf(path: string): string
/**
 * Address a decoded absolute file path through the authenticated file route.
 * @param base - HTTP(S) application base, including its deployment prefix, or `dsh-app://app/`.
 * @param path - Native file path; URL escapes in authored Markdown must already be decoded.
 * @returns File URL, or undefined for unsupported transports and non-absolute paths.
 */
export declare function fileMediaUrl(base: string, path: string): string | undefined
//# sourceMappingURL=index.d.ts.map
