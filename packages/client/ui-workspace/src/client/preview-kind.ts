/**
 * Pure preview-format helpers shared by the workbench navigation (which decides
 * a tab's renderer when opening a file) and the preview surface (which renders
 * it). Extension-to-renderer mapping and CSV parsing have no React or store
 * dependency, so they live apart from either component.
 */
import type { WorkbenchPreviewKind } from './stores.ts'

const BINARY_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'pdf', 'png', 'svg', 'webp'])
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  c: 'c', cc: 'cpp', cpp: 'cpp', css: 'css', go: 'go', h: 'c', hpp: 'cpp',
  java: 'java', js: 'javascript', json: 'json', jsonc: 'jsonc', jsx: 'jsx',
  kt: 'kotlin', mjs: 'javascript', php: 'php', py: 'python', rb: 'ruby', rs: 'rust',
  scss: 'scss', sh: 'bash', sql: 'sql', swift: 'swift', toml: 'toml', ts: 'typescript',
  tsx: 'tsx', vue: 'vue', xml: 'xml', yaml: 'yaml', yml: 'yaml', zsh: 'bash',
}

function extension(path: string): string {
  /* v8 ignore next -- split always returns at least one element, including for an empty string. */
  const name = path.split('/').pop() ?? path
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index + 1).toLowerCase()
}

/**
 * Resolve a file path to its read-only preview renderer.
 * @param path - workspace-relative file path.
 * @returns the preview family and, for source files, its syntax language.
 */
export function previewType(path: string): { kind: WorkbenchPreviewKind; language?: string } {
  const ext = extension(path)
  if (ext === 'md' || ext === 'mdx') return { kind: 'markdown' }
  if (ext === 'htm' || ext === 'html') return { kind: 'html' }
  if (ext === 'csv') return { kind: 'csv' }
  if (ext === 'pdf') return { kind: 'pdf' }
  if (BINARY_EXTENSIONS.has(ext)) return { kind: 'image' }
  const language = LANGUAGE_BY_EXTENSION[ext]
  return language === undefined ? { kind: 'text' } : { kind: 'code', language }
}

/** One bounded CSV preview table. */
export interface CsvPreview {
  rows: string[][]
  truncated: boolean
}

/**
 * Parse enough RFC-4180-style CSV for a bounded preview table.
 * @param content - CSV text to parse.
 * @param maxRows - maximum rows to retain.
 * @param maxColumns - maximum columns to retain per row.
 * @returns retained rows and whether either bound clipped the input.
 */
export function parseCsvPreview(content: string, maxRows = 100, maxColumns = 50): CsvPreview {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let truncated = false
  const pushRow = (): boolean => {
    row.push(field)
    field = ''
    if (row.length > maxColumns) {
      row = row.slice(0, maxColumns)
      truncated = true
    }
    rows.push(row)
    row = []
    return rows.length >= maxRows
  }
  for (let index = 0; index < content.length; index++) {
    const char = content.charAt(index)
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') { field += '"'; index++ }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && field === '') quoted = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\n') {
      if (pushRow()) return { rows, truncated: index < content.length - 1 || truncated }
    } else if (char !== '\r') field += char
  }
  if (field !== '' || row.length > 0) pushRow()
  return { rows, truncated }
}
