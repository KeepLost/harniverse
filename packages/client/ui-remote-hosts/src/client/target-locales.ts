/** Machine navigation copy, independent of the management view dictionary. */
export const en = {
  machine: 'Current machine',
  host: 'This machine',
  returnHost: 'Return to this machine',
} as const

/** Chinese labels for the machine-navigation surface. */
export const zh = {
  machine: '当前机器',
  host: '本机',
  returnHost: '返回本机',
} as const

/** Locale namespace used by the browser translation service. */
export const NS = 'machineTarget'

/** Translation keys shared by both machine-target locale dictionaries. */
export type MachineTargetKey = keyof typeof en
