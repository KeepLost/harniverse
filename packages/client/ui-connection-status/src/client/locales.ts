/** Connection health copy shared by the icon's accessible name and tooltip. */
export const en = {
  connecting: 'Connecting to the server',
  connected: 'Connected; authentication is valid',
  renewing: 'Connected; renewing authentication',
  recovering: 'Restoring authentication; requests are waiting',
  reconnecting: 'Connection interrupted; reconnecting automatically',
  required: 'Authentication cannot be restored. Refresh the page to authenticate again; revoked devices need approval.',
  bypass: 'Connected; local authentication bypass is enabled',
}
/** Simplified Chinese connection health copy. */
export const zh: Record<keyof typeof en, string> = {
  connecting: '正在连接服务器',
  connected: '连接正常，认证有效',
  renewing: '连接正常，正在更新认证',
  recovering: '正在恢复认证，发送请求将等待恢复完成',
  reconnecting: '连接已中断，正在自动重连',
  required: '认证无法自动恢复，请刷新网页重新认证；已撤销的设备需要重新批准。',
  bypass: '连接正常，当前为本地免认证模式',
}
