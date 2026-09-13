/** `governor` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'governor'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'view.open': '打开资源看板',
  'view.nav': '资源看板',
  'view.title': '资源看板',
  'view.refresh': '刷新',
  'view.close': '返回会话',
  'view.loading': '正在加载资源数据…',
  'view.error': '资源看板加载失败。',
  'view.retry': '重试',
  'view.empty': '当前没有正在运行的被计量命令。',
  'tier.cgroup': '执法档位：cgroup（内核精确记账与限额）',
  'tier.rlimit': '执法档位：rlimit（地址空间限额＋看门狗）',
  'tier.observe': '执法档位：仅观测',
  'global.usage': '全局内存预算：{used} / {limit}',
  'host.free': '磁盘剩余 {free}',
  'host.net': '网络 {rx}↓ / {tx}↑（最近一个采样间隔）',
  'table.session': '会话',
  'table.commands': '命令',
  'table.cpu': 'CPU（tick）',
  'table.memory': '内存（有效限额）',
  'table.quota': '配额',
  'table.breaches': '违约',
  'quota.shared': '共享池',
  'quota.set': '设置配额（MiB）',
  'quota.clear': '重回共享池',
  'quota.apply': '应用',
  'breach.memory-limit': '超全局内存限额被杀',
  'breach.session-quota': '超会话配额被杀',
  'units.bytes': '{value} B',
  'units.kib': '{value} KiB',
  'units.mib': '{value} MiB',
  'units.gib': '{value} GiB',
} as const

/** Governor board dictionary key set. */
export type GovernorKey = keyof typeof zh

/** English dictionary (key-identical to the Chinese source of truth). */
export const en: Record<GovernorKey, string> = {
  'view.open': 'Open the resource board',
  'view.nav': 'Resources',
  'view.title': 'Resource board',
  'view.refresh': 'Refresh',
  'view.close': 'Back to conversation',
  'view.loading': 'Loading resource data…',
  'view.error': 'The resource board failed to load.',
  'view.retry': 'Retry',
  'view.empty': 'No metered commands are running.',
  'tier.cgroup': 'Enforcement tier: cgroup (kernel-exact accounting and limits)',
  'tier.rlimit': 'Enforcement tier: rlimit (address-space caps plus watchdog)',
  'tier.observe': 'Enforcement tier: observe only',
  'global.usage': 'Global memory budget: {used} / {limit}',
  'host.free': 'Disk free: {free}',
  'host.net': 'Network {rx}↓ / {tx}↑ (last sample interval)',
  'table.session': 'Session',
  'table.commands': 'Commands',
  'table.cpu': 'CPU (ticks)',
  'table.memory': 'Memory (effective limit)',
  'table.quota': 'Quota',
  'table.breaches': 'Breaches',
  'quota.shared': 'Shared pool',
  'quota.set': 'Set quota (MiB)',
  'quota.clear': 'Rejoin shared pool',
  'quota.apply': 'Apply',
  'breach.memory-limit': 'killed over the global memory limit',
  'breach.session-quota': 'killed over the session quota',
  'units.bytes': '{value} B',
  'units.kib': '{value} KiB',
  'units.mib': '{value} MiB',
  'units.gib': '{value} GiB',
}
