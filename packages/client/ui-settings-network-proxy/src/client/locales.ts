/** `settings.network-proxy` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.network-proxy'

/** Locale key domain of this namespace. */
export type NetworkProxyLocaleKey = keyof typeof zh

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': '网络代理',
  'title': '网络代理',
  'intro': '选择进程出站 HTTP 请求的全局路由，保存后立即生效，无需重启。',
  'mode.off': '关闭',
  'mode.offDesc': '保持启动时的代理环境，不做任何更改。',
  'mode.system': '系统代理',
  'mode.systemDesc': '自动检测系统代理（Windows Internet 设置、macOS scutil、启动环境变量），每 30 秒刷新；检测失败时保持启动设置。',
  'mode.manual': '手动',
  'mode.manualDesc': '为所有出站请求指定固定代理服务器。',
  'url.label': '代理地址',
  'url.placeholder': 'http://127.0.0.1:7890',
  'url.invalid': '代理地址必须是 http:// 或 https:// 开头的有效 URL。',
  'noProxy.label': '例外列表',
  'noProxy.placeholder': 'localhost,127.0.0.1',
  'loading': '正在加载…',
  'unavailable': '此部署未暴露网络代理设置。',
  'readonly': '当前身份无写入权限。',
  'save': '保存',
  'saving': '保存中…',
  'revert': '放弃更改',
  'saved': '已保存，路由立即生效。',
  'saveFailed': '保存失败：{message}',
  'unknownError': '未知错误',
} as const

/** English dictionary (mirrors the Chinese key set). */
export const en: Record<NetworkProxyLocaleKey, string> = {
  'nav': 'Network Proxy',
  'title': 'Network Proxy',
  'intro': 'Choose the global route for outbound HTTP from this process; saving applies immediately with no restart.',
  'mode.off': 'Off',
  'mode.offDesc': 'Keep the launch-time proxy environment untouched.',
  'mode.system': 'System proxy',
  'mode.systemDesc': 'Detect the system proxy (Windows Internet settings, macOS scutil, launch environment variables) and refresh every 30s; a detection miss keeps the launch settings.',
  'mode.manual': 'Manual',
  'mode.manualDesc': 'Route all outbound requests through one fixed proxy server.',
  'url.label': 'Proxy URL',
  'url.placeholder': 'http://127.0.0.1:7890',
  'url.invalid': 'The proxy URL must be a valid http:// or https:// URL.',
  'noProxy.label': 'Exclusions',
  'noProxy.placeholder': 'localhost,127.0.0.1',
  'loading': 'Loading…',
  'unavailable': 'Network proxy settings are not exposed in this deployment.',
  'readonly': 'The current identity cannot write settings.',
  'save': 'Save',
  'saving': 'Saving…',
  'revert': 'Discard changes',
  'saved': 'Saved; the route applies immediately.',
  'saveFailed': 'Failed to save: {message}',
  'unknownError': 'Unknown error',
}
