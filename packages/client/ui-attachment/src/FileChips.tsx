/** Generic-file atoms: the composer's draft-file chips (upload progress,
 * error state, remove) and the message-flow file badges shown beside a user
 * message. Zero-cordis presentation — every string arrives resolved by the
 * owner. Size text uses the host handle text's human format so a chip, its
 * badge, and the model-visible handle line never disagree. */

import clsx from 'clsx'
import { IconCloseFill14, LinkIcon, classifyLinkPath } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './FileChips.module.css'

/** Byte count in the host handle text's human format (`958 B`, `1.5 KB`, `12 MB`). */
export function fileSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/** LinkIcon category for one file name (document/other link-color language). */
function fileGlyph(name: string): ReturnType<typeof classifyLinkPath> {
  const classified = classifyLinkPath(name)
  /* v8 ignore next -- classifyLinkPath never returns 'folder' or 'url' (those
   * kinds are caller-supplied elsewhere); the arms keep this mapper total over
   * LinkIconKind if that ever changes. */
  return classified === 'folder' || classified === 'url' ? 'other' : classified
}

/** One composer draft-file chip; strings arrive resolved (zero-cordis atom). */
export interface FileChipItem {
  /** Stable identity for the React key. */
  id: string
  /** Display file name. */
  name: string
  /** Total file bytes. */
  bytes: number
  /** Upload lifecycle state. */
  status: 'uploading' | 'done' | 'error'
  /** Uploaded fraction in 0..1 while measurable; absent otherwise. */
  progress?: number
  /** Error display line while `status === 'error'`. */
  error?: string
}

/** Chip-row strings the owner resolves from its own locale namespace. */
export interface FileChipLabels {
  /** Accessible name of the chip row group. */
  group: string
  /** Accessible label of one chip's remove control (receives the name). */
  removeLabel: (name: string) => string
  /** Chip tooltip while the upload is in flight. */
  uploading: string
}

/**
 * Composer chip row over the caller's draft files. Each chip shows the file
 * glyph (link color), name, and size; an in-flight upload carries a progress
 * bar (determinate when `progress` is known, indeterminate otherwise), an
 * error keeps the chip with its error line so the failure stays addressable,
 * and every chip removes through the owner callback. The owner decides
 * mounting; the row renders only while chips exist.
 *
 * @param props.items - draft file chips in draft order.
 * @param props.labels - row-level strings.
 * @param props.onRemove - remove one draft file.
 * @returns the chip row group.
 */
export function FileChipRail<T extends FileChipItem>({ items, labels, onRemove }: {
  items: readonly T[]
  labels: FileChipLabels
  onRemove: (item: T) => void
}) {
  return (
    <div className={css.rail} role="group" aria-label={labels.group}>
      {items.map((item) => {
        const percent = item.progress !== undefined ? Math.round(item.progress * 100) : undefined
        return (
          <div
            key={item.id}
            className={clsx(css.chip, item.status === 'error' && css.chipError)}
            data-file-chip={item.status}
            data-file-name={item.name}
          >
            <span className={css.chipIcon}><LinkIcon kind={fileGlyph(item.name)} /></span>
            <span className={css.chipBody}>
              <span className={css.chipName} title={item.name}>{item.name}</span>
              <span className={css.chipMeta}>
                {fileSizeText(item.bytes)}
                {item.status === 'error' && item.error !== undefined ? ` · ${item.error}` : ''}
              </span>
              {item.status === 'uploading' && (
                <span className={css.progress} role="progressbar" aria-label={labels.uploading}>
                  <span
                    className={css.progressFill}
                    style={percent === undefined ? undefined : { width: `${percent}%` }}
                    data-indeterminate={percent === undefined || undefined}
                  />
                </span>
              )}
            </span>
            <button
              type="button"
              className={css.remove}
              aria-label={labels.removeLabel(item.name)}
              onClick={() => { onRemove(item) }}
            >
              <IconCloseFill14 size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** One message-flow file badge (name + size only; display, not interactive). */
export interface FileBadgeItem {
  /** Display file name. */
  name: string
  /** File bytes. */
  bytes: number
}

/** Badge-row strings the owner resolves from its own locale namespace. */
export interface FileBadgeLabels {
  /** Accessible name of the badge row group. */
  group: string
}

/**
 * File badges for one user message: the receipts the prompt admitted, shown
 * as one link-colored row. Renders nothing without files.
 *
 * @param props.files - admitted file references in admitted order.
 * @param props.labels - row-level strings.
 * @returns the badge row, or null when no files.
 */
export function FileBadgeList({ files, labels }: { files: readonly FileBadgeItem[]; labels: FileBadgeLabels }) {
  if (files.length === 0) return null
  return (
    <div className={css.badges} role="group" aria-label={labels.group}>
      {files.map((file, index) => (
        <span key={`${file.name}-${index}`} className={css.badge} data-file-badge={file.name}>
          <LinkIcon kind={fileGlyph(file.name)} />
          <span className={css.badgeName} title={file.name}>{file.name}</span>
          <span className={css.badgeSize}>{fileSizeText(file.bytes)}</span>
        </span>
      ))}
    </div>
  )
}
