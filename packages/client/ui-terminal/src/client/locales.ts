/** `terminal` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'terminal'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.nav': '终端',
  'view.title': '终端',
  'view.close': '关闭工作区',
  'view.no-session': '选择或创建一个会话后即可在此使用终端。',
  'view.empty': '还没有终端，点击“新建终端”开始。',
  'tab.new': '新建终端',
  'tab.close': '关闭此终端',
  'tab.rename': '重命名此终端',
  'rename.save': '保存名称',
  'rename.label': '终端名称',
  'shell.label': 'Shell',
  'sessionShell.label': '会话 Shell',
  'sessionShell.hint': '切换会话的 shell：下一个模型请求生效，已有终端不受影响。',
  'sessionShell.unavailable': '该 shell 在此主机上不可用（{reason}）。',
  'shell.default': '默认',
  'state.running': '运行中',
  'state.exited': '已退出（代码 {code}）',
  'state.failed': '已失败',
  'readonly.notice': '输入由其他窗口持有，当前为只读。',
  'readonly.take': '接管输入',
  'reconnect.pending': '正在重新连接终端…',
  'reconnect.failed': '与终端的连接已中断，自动重连未成功。',
  'reconnect.retry': '重试',
  'surface.label': '终端输出',
  'keys.label': '控制键',
} as const

/** Terminal panel dictionary key set. */
export type TerminalKey = keyof typeof zh

/** English dictionary (key-identical to the Chinese source of truth). */
export const en: Record<TerminalKey, string> = {
  'view.nav': 'Terminal',
  'view.title': 'Terminal',
  'view.close': 'Close the workspace panel',
  'view.no-session': 'Select or create a session to use terminals here.',
  'view.empty': 'No terminals yet — press “New terminal” to start one.',
  'tab.new': 'New terminal',
  'tab.close': 'Close this terminal',
  'tab.rename': 'Rename this terminal',
  'rename.save': 'Save name',
  'rename.label': 'Terminal name',
  'shell.label': 'Shell',
  'shell.default': 'Default',
  'sessionShell.label': 'Session shell',
  'sessionShell.hint': "Switch this session's shell: effective at the next model request; existing terminals are untouched.",
  'sessionShell.unavailable': 'This shell is unavailable on the host ({reason}).',
  'state.running': 'Running',
  'state.exited': 'Exited (code {code})',
  'state.failed': 'Failed',
  'readonly.notice': 'Input is held by another window; this view is read-only.',
  'readonly.take': 'Take input',
  'reconnect.pending': 'Reconnecting to the terminal…',
  'reconnect.failed': 'The terminal connection broke and automatic reattach did not succeed.',
  'reconnect.retry': 'Retry',
  'surface.label': 'Terminal output',
  'keys.label': 'Control keys',
}
