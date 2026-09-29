/** Bilingual copy for the remote-host management surface. */

/** English labels for the remote-host management surface. */
export const en = {
  nav: 'Remote hosts', open: 'Open remote hosts', title: 'Remote hosts',
  summary: '{count} connected',
  refresh: 'Refresh', add: 'Add host', addTitle: 'Add remote host', close: 'Close',
  connect: 'Connect', openRemote: 'Open workspace',
  disconnect: 'Disconnect',
  remove: 'Remove',
  empty: 'No remote hosts configured yet. Add one to deploy and open a remote workspace.',
  stateOffline: 'Offline', stateConnecting: 'Connecting', stateDeploying: 'Deploying', stateConnected: 'Connected', stateError: 'Error',
  name: 'Name', host: 'Address', port: 'Port', username: 'User',
  platform: 'Platform', architecture: 'Architecture', auth: 'Login method', password: 'Password', privateKey: 'Private key',
  passphrase: 'Key passphrase', saveCredentials: 'Remember login credentials',
  keyPath: 'Key file path', chooseKeyDirectory: 'Choose directory', manualPaste: 'Paste key text instead',
  keyFileHint: 'Opens the host file chooser at ~/.ssh by default.',
  keyFileHintBrowse: 'Browse directories on the machine Harniverse runs on, then complete the file name after the path.',
  keyFileHintPaste: 'The key never needs to exist on this Harniverse host; paste its text and it is used as a one-time secret.',
  keyFileHintPath: 'Enter the absolute path of the key file on the machine Harniverse runs on, or paste the key text instead.',
  errorKeyPickUnavailable: 'This environment cannot open a host file chooser; enter or paste the key instead.',
  errorKeyPickFailed: 'Opening the key file chooser failed.',
  errorKeyFileTooLarge: 'The key file exceeds the 64 KiB limit.',
  errorKeyFileReadFailed: 'Reading the key file failed.',
  actionFailed: 'Remote host operation failed.',
  reverseMappings: 'Reverse mappings', localHost: 'Local host', localPort: 'Local port', remoteOrigin: 'Remote origin',
  addMapping: 'Add mapping', removeMapping: 'Remove mapping',
  mappingHint: 'Each mapping exposes one of this machine\'s loopback services to the remote host: settings synced there that reference the remote origin are rewritten to an SSH tunnel back to the local address.',
  test: 'Test connectivity', testPassed: 'Connected',
  testHint: 'A passed test records the host key and detects the remote platform; saving stays disabled until then.',
  save: 'Save host',
  cancel: 'Cancel',
} as const

/** Simplified Chinese labels for the remote-host management surface. */
export const zh = {
  nav: '远程主机', open: '打开远程主机', title: '远程主机',
  summary: '已连接 {count} 台',
  refresh: '刷新', add: '添加主机', addTitle: '添加远程主机', close: '关闭',
  connect: '连接', openRemote: '打开工作区',
  disconnect: '断开',
  remove: '删除',
  empty: '尚未配置远程主机。添加一台以部署并打开远程工作区。',
  stateOffline: '离线', stateConnecting: '连接中', stateDeploying: '部署中', stateConnected: '已连接', stateError: '错误',
  name: '名称', host: '地址', port: '端口', username: '用户',
  platform: '平台', architecture: '架构', auth: '登录方式', password: '密码', privateKey: '私钥',
  passphrase: '私钥口令', saveCredentials: '记住登录凭据',
  keyPath: '密钥文件路径', chooseKeyDirectory: '选择目录', manualPaste: '手动粘贴密钥内容',
  keyFileHint: '默认打开主机账号的 ~/.ssh 目录。',
  keyFileHintBrowse: '浏览 Harniverse 所在机器的目录，确认后在路径后补全密钥文件名。',
  keyFileHintPaste: '密钥无需存在于 Harniverse 所在机器上；粘贴的内容仅作为一次性凭据使用。',
  keyFileHintPath: '填写密钥文件在 Harniverse 所在机器上的绝对路径，或改用粘贴密钥内容。',
  errorKeyPickUnavailable: '此环境无法打开主机文件选择器，请直接填写路径或粘贴密钥内容。',
  errorKeyPickFailed: '打开密钥文件选择器失败。',
  errorKeyFileTooLarge: '密钥文件超过 64 KiB 上限。',
  errorKeyFileReadFailed: '读取密钥文件失败。',
  actionFailed: '远程主机操作失败。',
  reverseMappings: '反向映射', localHost: '本地主机', localPort: '本地端口', remoteOrigin: '远端来源',
  addMapping: '添加映射', removeMapping: '删除映射',
  mappingHint: '每条映射把本机的一个回环服务经 SSH 反向隧道暴露给远端主机：同步到远端的设置里匹配该来源地址的条目会被改写为指回本机地址的隧道地址。',
  test: '检测连通性', testPassed: '已连通',
  testHint: '检测通过后记录主机密钥并识别远端平台；在此之前保存保持禁用。',
  save: '保存主机',
  cancel: '取消',
} as const

/** Translation keys shared by both remote-host locale dictionaries. */
export type RemoteHostsKey = keyof typeof en

/** Locale namespace used by the browser translation service. */
export const NS = 'remoteHosts'
