/**
 * `tool` namespace dictionaries: preparation copy for atomic Tool views.
 * The conversation namespace is frozen to the conversation owner, so the
 * Tool layer's own keys live here and reach views through the owner's
 * `tTool` seat.
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'tool'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.preparing': '正在准备调用',
  'tool.preparing.content': '正在准备内容 {kilobytes}KB',
} satisfies Record<string, string>

/** The tool namespace key union. */
export type ToolKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.preparing': 'Preparing tool call',
  'tool.preparing.content': 'Preparing content {kilobytes}KB',
} satisfies Record<ToolKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Atomic Tool view preparation copy. */
    tool: ToolKey
  }
}
