/**
 * Dictionary of the editor occupant's user-facing copy.
 * @module ui-workspace-editor/locales
 */

export const zh = {
  'editor.save': '保存',
  'editor.saveAria': '保存对 {name} 的修改',
  'editor.saving': '保存中…',
  'editor.saved': '已保存',
  'editor.dirty': '有未保存的修改',
  'editor.clean': '无修改',
  'editor.loading': '正在打开 {name}…',
  'editor.unavailable': '此文件不可编辑：{reason}',
  'editor.error': '保存失败：{reason}',
  'editor.conflictTitle': '文件在磁盘上已被修改',
  'editor.conflictDescription': '自你打开以来，其他程序保存了此文件的新版本。',
  'editor.conflictReload': '放弃修改并重新加载',
  'editor.conflictOverwrite': '覆盖磁盘版本',
  'editor.conflictDiff': '对比修改',
  'editor.conflictHideDiff': '收起对比',
  'editor.diffDisk': '磁盘上的最新内容',
  'editor.diffDraft': '你的修改',
  'editor.editorAria': '文件 {path} 的编辑器',
  'editor.contentAria': '正在编辑 {path}',
  'editor.statusAria': '编辑状态',
  'editor.encoding': '编码 {encoding}{bom} · {eol}',
  'editor.encodingBom': ' · BOM',
  'editor.watchUnsupported': '文件变动监视不可用，外部修改不会自动提示',
} as const

/** English dictionary; it carries the same key set as `zh`. */
export const en = {
  'editor.save': 'Save',
  'editor.saveAria': 'Save changes to {name}',
  'editor.saving': 'Saving…',
  'editor.saved': 'Saved',
  'editor.dirty': 'Unsaved changes',
  'editor.clean': 'No changes',
  'editor.loading': 'Opening {name}…',
  'editor.unavailable': 'This file cannot be edited: {reason}',
  'editor.error': 'Save failed: {reason}',
  'editor.conflictTitle': 'The file changed on disk',
  'editor.conflictDescription': 'Another program saved a newer version since you opened it.',
  'editor.conflictReload': 'Discard my changes and reload',
  'editor.conflictOverwrite': 'Overwrite the disk version',
  'editor.conflictDiff': 'Compare changes',
  'editor.conflictHideDiff': 'Hide comparison',
  'editor.diffDisk': 'Latest on disk',
  'editor.diffDraft': 'Your changes',
  'editor.editorAria': 'Editor for {path}',
  'editor.contentAria': 'Editing {path}',
  'editor.statusAria': 'Editor status',
  'editor.encoding': 'Encoding {encoding}{bom} · {eol}',
  'editor.encodingBom': ' · BOM',
  'editor.watchUnsupported': 'File watching is unavailable; external changes are not signaled',
} as const

/** Dictionary keys of the editor namespace. */
export type WorkspaceEditorKey = keyof typeof zh

/** The editor namespace dictionaries. */
export const editorDictionaries: { zh: typeof zh; en: typeof en } = { zh, en }
