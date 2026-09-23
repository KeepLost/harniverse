/** `browser` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'browser'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.nav': '浏览器',
  'view.title': '浏览器',
  'view.close': '关闭工作区',
  'view.empty': '在上方输入网址，回车即可在宿主机上打开。',
  'view.loading': '正在加载浏览器页面…',
  'view.no-session': '请先选择一个会话，再使用浏览器面板。',
  'view.unavailable': '宿主机上没有可用的浏览器程序，无法在此打开页面。可为宿主机配置浏览器路径，或在设置中把链接改到本机浏览器打开。',
  'url.label': '地址',
  'url.placeholder': '输入 http/https 网址，回车打开',
  'url.go': '打开',
  'nav.back': '后退',
  'nav.forward': '前进',
  'nav.reload': '刷新',
  'nav.stop': '停止加载',
  'tabs.label': '页面',
  'tabs.new': '新建页面',
  'tabs.close': '关闭页面',
  'tabs.blank': '空白页',
  'surface.label': '宿主机网页画面',
  'control.readonly': '该页面正由其他窗口控制，当前为只读。',
  'control.take': '取回控制权',
  'recover.failed': '页面画面连接已断开。',
  'recover.retry': '重新连接',
} as const

/** Browser panel dictionary key set. */
export type BrowserKey = keyof typeof zh

/** English dictionary (key-identical to the Chinese source of truth). */
export const en: Record<BrowserKey, string> = {
  'view.nav': 'Browser',
  'view.title': 'Browser',
  'view.close': 'Close the workspace panel',
  'view.empty': 'Type a URL above and press Enter to open it on the host.',
  'view.loading': 'Loading browser pages\u2026',
  'view.no-session': 'Select a session to use the browser panel.',
  'view.unavailable': 'No browser program is available on the host, so pages cannot open here. Configure a browser path for the host, or switch links to your own browser in Settings.',
  'url.label': 'Address',
  'url.placeholder': 'Enter an http/https URL and press Enter',
  'url.go': 'Open',
  'nav.back': 'Go back',
  'nav.forward': 'Go forward',
  'nav.reload': 'Reload',
  'nav.stop': 'Stop loading',
  'tabs.label': 'Pages',
  'tabs.new': 'New page',
  'tabs.close': 'Close page',
  'tabs.blank': 'Blank page',
  'surface.label': 'Host web page',
  'control.readonly': 'Another window controls this page; it is read-only here.',
  'control.take': 'Take control',
  'recover.failed': 'The page stream disconnected.',
  'recover.retry': 'Reconnect',
}
