/** `browser` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'browser'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.open': '打开浏览器面板',
  'view.nav': '浏览器',
  'view.title': '浏览器',
  'view.close': '返回会话',
  'view.empty': '在上方输入网址，回车打开。',
  'url.label': '地址',
  'url.placeholder': '输入 http/https 网址，回车打开',
  'url.go': '打开',
  'nav.back': '后退',
  'nav.forward': '前进',
  'nav.reload': '刷新',
  'frame.title': '嵌入的网页',
  'reject.title': '无法打开该网址',
  'reject.empty': '请输入网址。',
  'reject.malformed': '无法解析该网址，请输入完整的 http/https 地址。',
  'reject.scheme': '仅支持 http 与 https 协议的网址。',
  'reject.credentials': '不接受内嵌用户名或密码的网址。',
  'reject.self-origin': '不能在面板中打开本应用自身的地址。',
  'reject.host-not-allowed': '该主机不在允许的地址列表中。',
} as const

/** Browser panel dictionary key set. */
export type BrowserKey = keyof typeof zh

/** English dictionary (key-identical to the Chinese source of truth). */
export const en: Record<BrowserKey, string> = {
  'view.open': 'Open the browser panel',
  'view.nav': 'Browser',
  'view.title': 'Browser',
  'view.close': 'Back to conversation',
  'view.empty': 'Type a URL above and press Enter to open it.',
  'url.label': 'Address',
  'url.placeholder': 'Enter an http/https URL and press Enter',
  'url.go': 'Open',
  'nav.back': 'Go back',
  'nav.forward': 'Go forward',
  'nav.reload': 'Reload',
  'frame.title': 'Embedded web page',
  'reject.title': 'This URL cannot be opened',
  'reject.empty': 'Enter a URL.',
  'reject.malformed': 'This URL cannot be parsed; enter a complete http/https address.',
  'reject.scheme': 'Only http and https URLs are supported.',
  'reject.credentials': 'URLs with an embedded username or password are not accepted.',
  'reject.self-origin': 'The panel cannot open this application\u2019s own address.',
  'reject.host-not-allowed': 'This host is not on the allowed list.',
}
