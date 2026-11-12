/** `sidebar` namespace dictionaries: shell controls (brand row, New Session, fold toggle). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'session.new': '新会话',
  'session.new.shell.aria': '选择 Shell 新建会话',
  'session.new.shell.default': '默认（跟随设置）',
  'session.new.shell.unavailable': '此 Shell 在主机上不可用',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'session.new': 'New Session',
  'session.new.shell.aria': 'New session with a chosen shell',
  'session.new.shell.default': 'Default (follow settings)',
  'session.new.shell.unavailable': 'This shell is unavailable on the host',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
} satisfies Record<SidebarKey, string>
