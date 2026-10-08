/**
 * Extension-to-CodeMirror-language mapping over the minimal language set
 * pinned for this package. The map follows the preview's supported
 * extension subset; unmapped paths edit as plain text.
 * @module ui-workspace-editor/languages
 */
import type { Extension } from '@codemirror/state'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'

/** Lowercased extension of a workspace-relative path, without its dot. */
function extensionOf(path: string): string {
  /* v8 ignore next -- split always returns at least one element, so the
     fallback is unreachable for every string path. */
  const name = path.split('/').pop() ?? path
  const index = name.lastIndexOf('.')
  return index === -1 ? '' : name.slice(index + 1).toLowerCase()
}

/**
 * Language support extensions for one document path.
 * @param path - workspace-relative document path.
 * @returns the language extensions, or an empty array for plain text.
 */
export function languageExtensions(path: string): Extension[] {
  switch (extensionOf(path)) {
    case 'js': case 'mjs': case 'cjs': case 'jsx':
      return [javascript({ jsx: true })]
    case 'ts': case 'mts': case 'cts': case 'tsx':
      return [javascript({ typescript: true, jsx: true })]
    case 'json':
      return [json()]
    case 'py':
      return [python()]
    case 'html': case 'htm': case 'vue': case 'svelte':
      return [html()]
    case 'css':
      return [css()]
    case 'md': case 'markdown':
      return [markdown()]
    default:
      return []
  }
}
