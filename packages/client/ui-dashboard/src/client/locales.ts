/** `dashboard` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'dashboard'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.open': '打开仪表盘',
  'view.nav': '仪表盘',
  'view.title': '仪表盘',
  'view.close': '返回会话',
} as const

/** Dashboard dictionary key set. */
export type DashboardKey = keyof typeof zh

/** English dictionary (key-identical to the Chinese source of truth). */
export const en: Record<DashboardKey, string> = {
  'view.open': 'Open the dashboard',
  'view.nav': 'Dashboard',
  'view.title': 'Dashboard',
  'view.close': 'Back to conversation',
}
