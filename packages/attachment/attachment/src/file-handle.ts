/**
 * The deterministic handle text a model sees for one stored generic file.
 * @module @deepseek-ai/dsh-attachment/file-handle
 */

import type { FileAttachmentRef, ImageAttachmentRef } from './types.ts'

/** Format one byte count as the human-facing size in the handle text. */
function humanBytes(bytes: number): string {
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

/**
 * Build the deterministic model-visible handle text for one stored file. The
 * text names the file, its size, its digest prefix, and the read-only path the
 * read tool reaches it through, then states the reading contract. Identical
 * inputs always produce identical text, so a replayed log shows the exact text
 * the model saw.
 * @param ref - the durable reference recorded alongside the message.
 * @param path - the absolute read-only hard-link path the model reads through.
 * @returns the handle text, newline-terminated lines without a trailing newline.
 */
export function fileHandleText(ref: FileAttachmentRef, path: string): string {
  const sha8 = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  const name = ref.name ?? sha8
  return [
    `[文件] ${name} · ${humanBytes(ref.bytes)} · sha256:${sha8}`,
    `只读路径: ${path}`,
    '用 read 工具读取该路径获得内容；不要凭名字猜测内容。',
  ].join('\n')
}

/**
 * Build the deterministic model-visible handle text for one stored image
 * that a modality offload replaced with a text stub. Mirrors
 * {@link fileHandleText}: the text names the image, its size, its digest
 * prefix, and the read-only path the `read_image` tool reaches it through,
 * then states that the current model cannot view images, so the model never
 * treats the removed occurrence as visible. Identical inputs always produce
 * identical text, so a replayed log shows the exact text the model saw.
 * @param ref - the durable image reference recorded alongside the message.
 * @param path - the absolute read-only hard-link path the read tool reaches the image through.
 * @returns the handle text, newline-terminated lines without a trailing newline.
 */
export function imageHandleText(ref: ImageAttachmentRef, path: string): string {
  const sha8 = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  const name = ref.name ?? sha8
  return [
    `[图片] ${name} · ${humanBytes(ref.bytes)} · sha256:${sha8}`,
    `只读路径: ${path}`,
    '当前模型无法查看图片，原图已从本次请求移除；切换到视觉模型后可用 read_image 工具读取该路径重新查看。',
  ].join('\n')
}
