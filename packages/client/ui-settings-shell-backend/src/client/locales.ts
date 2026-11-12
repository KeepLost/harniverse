/** `settings.shell-backend` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.shell-backend'

/** Locale key domain of this namespace. */
export type ShellBackendLocaleKey = keyof typeof zh

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': 'Shell 默认',
  'title': 'Shell 默认',
  'intro': '选择未作单独选择的会话默认使用的 shell；保存的更改在下次启动时生效。可选项含两个内置项（平台 POSIX shell 与 PowerShell）以及注册表中的自定义条目。',
  'default.platform-default': '跟随平台默认（推荐）',
  'default.platform-defaultDesc': 'Windows 组合 PowerShell 工具栈，其他平台组合平台 POSIX shell（macOS 为 zsh，Linux 为 bash，Windows 为 Git Bash）。',
  'default.posix': 'POSIX shell',
  'default.posixDesc': '组合 POSIX 工具栈（bash 工具）；Windows 上为 Git Bash，需要已安装 Git 且 bash 位于 PATH。',
  'default.pwsh': 'PowerShell',
  'default.pwshDesc': '组合 PowerShell 工具栈（pwsh 工具）；需要已安装 pwsh。',
  'loading': '正在加载…',
  'unavailable': '此部署未暴露 Shell 设置。',
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
  'nav': 'Shell Default',
  'title': 'Shell Default',
  'intro': 'Choose the shell sessions use when they select none themselves; a saved change applies on the next start. Options cover the two builtins (the platform POSIX shell and PowerShell) plus registered custom entries.',
  'default.platform-default': 'Follow the platform default (recommended)',
  'default.platform-defaultDesc': 'Windows composes the PowerShell tool stack; other platforms compose the platform POSIX shell (zsh on macOS, bash on Linux, Git Bash on Windows).',
  'default.posix': 'POSIX shell',
  'default.posixDesc': 'Compose the POSIX tool stack (the bash tool); Git Bash on Windows, requiring Git installed with bash on PATH.',
  'default.pwsh': 'PowerShell',
  'default.pwshDesc': 'Compose the PowerShell tool stack (the pwsh tool); requires pwsh installed.',
  'loading': 'Loading…',
  'unavailable': 'Shell settings are not exposed in this deployment.',
  'readonly': 'The current identity cannot write settings.',
  'save': 'Save',
  'saving': 'Saving…',
  'revert': 'Revert',
  'saved': 'Saved; applies on the next start.',
  'saveFailed': 'Save failed: {message}',
  'unknownError': 'Unknown error',
}
