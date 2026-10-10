/** `settings.theme` namespace dictionaries (the Appearance section's nav label and its color-mode and font-size rows' copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.nav': '外观',
  'appearance.title': '颜色模式',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'fontSize.title': '字号',
  'fontSize.small': '小',
  'fontSize.medium': '中',
  'fontSize.large': '大',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'section.nav': 'Appearance',
  'appearance.title': 'Color mode',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'fontSize.title': 'Font size',
  'fontSize.small': 'Small',
  'fontSize.medium': 'Medium',
  'fontSize.large': 'Large',
} satisfies Record<ThemeKey, string>
