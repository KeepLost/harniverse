/** `settings.global-rules` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.global-rules'

/** Locale key domain of this namespace. */
export type GlobalRulesLocaleKey = keyof typeof zh

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': '全局规则',
  'title': '全局规则',
  'intro': '编辑 {path}，对所有会话生效。保存后：新会话在第一步读取新内容；当前会话在下一次文件操作后感知变更。',
  'notExists': '文件尚不存在，保存后将创建它。',
  'loading': '正在加载…',
  'loadFailed': '读取失败：{message}',
  'retry': '重试',
  'unavailable': '全局规则编辑在此部署中不可用。',
  'unknownError': '未知错误',
  'editorLabel': '全局规则内容（Markdown）',
  'placeholder': '# 全局规则\n\n在这里编写对所有会话生效的指令…',
  'save': '保存',
  'saving': '保存中…',
  'revert': '放弃更改',
  'saved': '已保存。新会话将在第一步读取新内容；当前会话在下一次文件操作后感知。',
  'saveFailed': '保存失败：{message}',
  'conflict': '文件在加载后被外部修改，本次未保存。',
  'reload': '重新加载',
  'overCap': '内容 {used} 超过 {max} 上限，保存已禁用。',
  'bytes': '{used} / {max}',
} as const

/** English dictionary (mirrors the Chinese key set). */
export const en: Record<GlobalRulesLocaleKey, string> = {
  'nav': 'Global Rules',
  'title': 'Global Rules',
  'intro': 'Edit {path}; it applies to every session. After saving: new sessions read it on their first step; the current session detects the change after its next file operation.',
  'notExists': 'The file does not exist yet; saving will create it.',
  'loading': 'Loading…',
  'loadFailed': 'Failed to read: {message}',
  'retry': 'Retry',
  'unavailable': 'The global rules editor is unavailable in this deployment.',
  'unknownError': 'Unknown error',
  'editorLabel': 'Global rules content (Markdown)',
  'placeholder': '# Global Rules\n\nWrite instructions here that take effect across every session…',
  'save': 'Save',
  'saving': 'Saving…',
  'revert': 'Discard changes',
  'saved': 'Saved. New sessions read the new content on their first step; the current session detects it after its next file operation.',
  'saveFailed': 'Failed to save: {message}',
  'conflict': 'The file changed externally after it was loaded; nothing was saved.',
  'reload': 'Reload',
  'overCap': 'Content {used} exceeds the {max} cap; saving is disabled.',
  'bytes': '{used} / {max}',
}
