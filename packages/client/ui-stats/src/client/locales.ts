/** `ui-stats` namespace dictionaries (view tab label, table copy, totals). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'ui-stats'

/** The stats dictionary key set (the source of truth for both locales). */
export type StatsKey =
  | 'view.label'
  | 'state.empty'
  | 'state.loading'
  | 'state.running'
  | 'state.interrupted'
  | 'state.openTool'
  | 'controls.loadOlder'
  | 'controls.expand'
  | 'controls.collapse'
  | 'col.turn'
  | 'col.trigger'
  | 'col.steps'
  | 'col.context'
  | 'col.output'
  | 'col.ttft'
  | 'col.model'
  | 'col.decode'
  | 'col.tps'
  | 'col.tool'
  | 'col.cache'
  | 'col.retries'
  | 'col.errors'
  | 'col.did'
  | 'trigger.user'
  | 'trigger.plugin'
  | 'trigger.unknown'
  | 'trigger.images'
  | 'trigger.files'
  | 'close.completed'
  | 'close.aborted'
  | 'close.blocked'
  | 'close.error'
  | 'close.max-tokens'
  | 'close.interrupted'
  | 'compaction.title'
  | 'compaction.shadowed'
  | 'totals.caption'
  | 'totals.turns'
  | 'totals.steps'
  | 'totals.model'
  | 'totals.tool'
  | 'totals.ttft'
  | 'totals.tps'
  | 'totals.output'
  | 'totals.cacheHit'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The stats view tab label and table strings. */
    'ui-stats': StatsKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<StatsKey, string> = {
  'view.label': '统计',
  'state.empty': '暂无统计数据',
  'state.loading': '加载中…',
  'state.running': '进行中',
  'state.interrupted': '已中断',
  'state.openTool': '未完成',
  'controls.loadOlder': '加载更早轮次',
  'controls.expand': '展开轮次',
  'controls.collapse': '收起轮次',
  'col.turn': '轮次',
  'col.trigger': '触发',
  'col.steps': '步数',
  'col.context': '上下文',
  'col.output': '输出',
  'col.ttft': '首字',
  'col.model': '模型',
  'col.decode': '解码',
  'col.tps': '速度',
  'col.tool': '工具',
  'col.cache': '缓存',
  'col.retries': '重试',
  'col.errors': '错误',
  'col.did': '结果',
  'trigger.user': '用户',
  'trigger.plugin': '插件',
  'trigger.unknown': '未知',
  'trigger.images': '图片',
  'trigger.files': '文件',
  'close.completed': '完成',
  'close.aborted': '取消',
  'close.blocked': '受阻',
  'close.error': '出错',
  'close.max-tokens': '达输出上限',
  'close.interrupted': '中断',
  'compaction.title': '压缩',
  'compaction.shadowed': '折叠',
  'totals.caption': '已加载窗口合计',
  'totals.turns': '轮次',
  'totals.steps': '步数',
  'totals.model': '模型时间',
  'totals.tool': '工具时间',
  'totals.ttft': '平均首字',
  'totals.tps': '综合速度',
  'totals.output': '输出 tokens',
  'totals.cacheHit': '缓存命中',
}

/** English dictionary. */
export const en: Record<StatsKey, string> = {
  'view.label': 'Statistics',
  'state.empty': 'No statistics yet',
  'state.loading': 'Loading…',
  'state.running': 'Running',
  'state.interrupted': 'Interrupted',
  'state.openTool': 'Open',
  'controls.loadOlder': 'Load earlier turns',
  'controls.expand': 'Expand turn',
  'controls.collapse': 'Collapse turn',
  'col.turn': 'Turn',
  'col.trigger': 'Trigger',
  'col.steps': 'Steps',
  'col.context': 'Context',
  'col.output': 'Output',
  'col.ttft': 'TTFT',
  'col.model': 'Model',
  'col.decode': 'Decode',
  'col.tps': 'Speed',
  'col.tool': 'Tool',
  'col.cache': 'Cache',
  'col.retries': 'Retries',
  'col.errors': 'Errors',
  'col.did': 'Did',
  'trigger.user': 'User',
  'trigger.plugin': 'Plugin',
  'trigger.unknown': 'Unknown',
  'trigger.images': 'images',
  'trigger.files': 'files',
  'close.completed': 'Completed',
  'close.aborted': 'Aborted',
  'close.blocked': 'Blocked',
  'close.error': 'Error',
  'close.max-tokens': 'Max tokens',
  'close.interrupted': 'Interrupted',
  'compaction.title': 'Compaction',
  'compaction.shadowed': 'Shadowed',
  'totals.caption': 'Loaded-window totals',
  'totals.turns': 'Turns',
  'totals.steps': 'Steps',
  'totals.model': 'Model time',
  'totals.tool': 'Tool time',
  'totals.ttft': 'Avg TTFT',
  'totals.tps': 'Aggregate speed',
  'totals.output': 'Output tokens',
  'totals.cacheHit': 'Cache hit',
}
