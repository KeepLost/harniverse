/** `settings.shell-backend` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.shell-backend'

/** Locale key domain of this namespace. */
export type ShellBackendLocaleKey = keyof typeof zh

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': 'Shell 后端',
  'title': 'Shell 后端',
  'intro': '选择 Windows 上模型 Shell 工具组合使用的家族；保存的更改在下次启动时生效。非 Windows 平台上此设置无效。',
  'backend.platform-default': 'PowerShell（默认）',
  'backend.platform-defaultDesc': 'Windows 平台默认组合 PowerShell 工具栈（pwsh 与常驻 pwsh）。',
  'backend.git-bash': 'Git Bash',
  'backend.git-bashDesc': '改为组合 Git for Windows 提供的 bash 工具栈；需要已安装 Git 且 bash 位于 PATH。',
  'loading': '正在加载…',
  'unavailable': '此部署未暴露 Shell 后端设置。',
  'readonly': '当前身份无写入权限。',
  'save': '保存',
  'saving': '保存中…',
  'revert': '放弃更改',
  'saved': '已保存，重启后生效。',
  'saveFailed': '保存失败：{message}',
  'unknownError': '未知错误',
} as const

/** English dictionary (mirrors the Chinese key set). */
export const en: Record<ShellBackendLocaleKey, string> = {
  'nav': 'Shell Backend',
  'title': 'Shell Backend',
  'intro': 'Choose which shell family the model shell tools compose on Windows; a saved change applies on the next start. The preference is inert on other platforms.',
  'backend.platform-default': 'PowerShell (default)',
  'backend.platform-defaultDesc': 'The Windows platform default composes the PowerShell tool stack (pwsh and the persistent pwsh).',
  'backend.git-bash': 'Git Bash',
  'backend.git-bashDesc': 'Compose the bash tool stack from Git for Windows instead; requires Git installed with bash on PATH.',
  'loading': 'Loading…',
  'unavailable': 'Shell backend settings are not exposed in this deployment.',
  'readonly': 'The current identity cannot write settings.',
  'save': 'Save',
  'saving': 'Saving…',
  'revert': 'Discard changes',
  'saved': 'Saved; it applies on the next start.',
  'saveFailed': 'Failed to save: {message}',
  'unknownError': 'Unknown error',
}
