/** `settings.exec-world` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.exec-world'

/** Locale key domain of this namespace. */
export type ExecWorldLocaleKey = keyof typeof zh

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': '执行世界',
  'title': '执行世界',
  'intro': '选择会话运行的能力家族：宿主本地进程，或完全隔离的 QEMU 微虚拟机世界；保存的更改在下次启动时生效。选择虚拟机世界需要宿主上有可用的 QEMU 与已构建资产；探查不健康时启动自动回退本地家族。',
  'world.local': '宿主本地（默认）',
  'world.localDesc': '子进程、文件与沙箱能力由宿主本地提供者组合；与既有部署形态一致。',
  'world.vm': 'VM 世界（真沙箱）',
  'world.vmDesc': '能力家族切换到 microVM：会话在自有内核与文件系统的来宾机内执行，宿主边界即沙箱；未显式指定权限模式时按完全访问组合（世界边界即隔离）。',
  'loading': '正在加载…',
  'unavailable': '此部署未暴露执行世界设置。',
  'readonly': '当前身份无写入权限。',
  'save': '保存',
  'saving': '保存中…',
  'revert': '放弃更改',
  'saved': '已保存，重启后生效。',
  'saveFailed': '保存失败：{message}',
  'unknownError': '未知错误',
} as const

/** English dictionary (mirrors the Chinese key set). */
export const en: Record<ExecWorldLocaleKey, string> = {
  'nav': 'Execution World',
  'title': 'Execution World',
  'intro': 'Choose which capability family sessions compose: host-local processes, or a fully isolated QEMU microvm world; a saved change applies on the next start. The VM world requires a working QEMU and built assets on the host; an unhealthy probe degrades back to the local family at startup.',
  'world.local': 'Host local (default)',
  'world.localDesc': 'Subprocess, filesystem, and sandbox capabilities compose the host-local providers; identical to the existing deployment shape.',
  'world.vm': 'VM world (true sandbox)',
  'world.vmDesc': 'Switch the family to a microvm: sessions execute inside a guest with its own kernel and filesystem, the host boundary being the sandbox; without an explicit permission mode the composition resolves full access (the world boundary is the isolation).',
  'loading': 'Loading…',
  'unavailable': 'Execution world settings are not exposed in this deployment.',
  'readonly': 'The current identity cannot write settings.',
  'save': 'Save',
  'saving': 'Saving…',
  'revert': 'Discard changes',
  'saved': 'Saved; it applies on the next start.',
  'saveFailed': 'Failed to save: {message}',
  'unknownError': 'Unknown error',
}
