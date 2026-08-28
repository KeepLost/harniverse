/** Simplified Chinese layout accessibility copy. */
export const zh = {
  'resize.sidebar': '调整侧栏宽度',
  'resize.right': '调整右侧面板宽度',
  'drawer.details': '会话详情',
  'drawer.workbench': '工作区工作台',
} as const

/** English layout accessibility copy. */
export const en: Record<keyof typeof zh, string> = {
  'resize.sidebar': 'Resize sidebar',
  'resize.right': 'Resize right panel',
  'drawer.details': 'Session details',
  'drawer.workbench': 'Workspace workbench',
}

/** Closed key set for the layout locale namespace. */
export type LayoutKey = keyof typeof zh
