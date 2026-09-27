/** English labels for the remote-host management surface. */
export const en = {
  nav: 'Remote hosts',
  open: 'Open remote hosts',
  title: 'Remote hosts',
  add: 'Add host',
  refresh: 'Refresh',
  connect: 'Connect', openRemote: 'Open workspace',
  disconnect: 'Disconnect',
  remove: 'Remove',
  probe: 'Probe host key',
  save: 'Save host',
  cancel: 'Cancel',
  empty: 'No remote hosts configured',
  stateOffline: 'Offline', stateConnecting: 'Connecting', stateDeploying: 'Deploying', stateConnected: 'Connected', stateError: 'Error',
  name: 'Name', host: 'Address', port: 'Port', username: 'User', fingerprint: 'SHA-256 host fingerprint',
  platform: 'Platform', architecture: 'Architecture', auth: 'Login method', password: 'Password', privateKey: 'Private key',
  passphrase: 'Key passphrase', saveCredentials: 'Remember login credentials',
  reverseMappings: 'Reverse mappings', localHost: 'Local host', localPort: 'Local port', remoteOrigin: 'Remote origin',
  addMapping: 'Add mapping', removeMapping: 'Remove mapping', fingerprintHint: 'Verify this fingerprint independently before saving.',
} as const

/** Simplified Chinese labels for the remote-host management surface. */
export const zh = {
  nav: '远程主机', open: '打开远程主机', title: '远程主机', add: '添加主机', refresh: '刷新', connect: '连接', disconnect: '断开', remove: '删除', probe: '探测主机指纹', save: '保存主机', cancel: '取消', empty: '尚未配置远程主机',
  stateOffline: '离线', stateConnecting: '连接中', stateDeploying: '部署中', stateConnected: '已连接', stateError: '错误', name: '名称', host: '地址', port: '端口', username: '用户', fingerprint: 'SHA-256 主机指纹', platform: '平台', architecture: '架构', auth: '登录方式', password: '密码', privateKey: '私钥', passphrase: '私钥口令', saveCredentials: '记住登录凭据', reverseMappings: '反向映射', localHost: '本地主机', localPort: '本地端口', remoteOrigin: '远端来源', addMapping: '添加映射', removeMapping: '删除映射', fingerprintHint: '请先独立验证此指纹，再保存。', openRemote: '打开工作区',
} as const

/** Translation keys shared by both remote-host locale dictionaries. */
export type RemoteHostsKey = keyof typeof en
/** Locale namespace used by the browser translation service. */
export const NS = 'remoteHosts'
