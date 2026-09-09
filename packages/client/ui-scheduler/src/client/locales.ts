/** `schedule` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'schedule'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'count.active.one': '{count} 个定时任务',
  'count.active.other': '{count} 个定时任务',
  'count.paused.one': '{count} 个已暂停任务',
  'count.paused.other': '{count} 个已暂停任务',
  'list.aria': '定时任务',
  'row.aria': '定时任务 {prompt}',
  'due.none': '已结束',
  'action.pause': '暂停',
  'action.resume': '恢复',
  'action.delete': '删除',
  'empty': '本会话还没有定时任务。',
} as const

/** Dictionary key set derived from the Chinese source of truth. */
export type ScheduleKey = keyof typeof zh

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<ScheduleKey, string> = {
  'count.active.one': '{count} scheduled task',
  'count.active.other': '{count} scheduled tasks',
  'count.paused.one': '{count} paused task',
  'count.paused.other': '{count} paused tasks',
  'list.aria': 'Scheduled tasks',
  'row.aria': 'Scheduled task {prompt}',
  'due.none': 'finished',
  'action.pause': 'Pause',
  'action.resume': 'Resume',
  'action.delete': 'Delete',
  'empty': 'No scheduled tasks for this session yet.',
}
