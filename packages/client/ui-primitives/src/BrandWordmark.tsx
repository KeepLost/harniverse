import type { IconProps } from './icons/props.ts'

/**
 * Render the Harniverse wordmark as plain text.
 * @param props.size - text height in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the decorative Harniverse text used by the sidebar.
 */
export function BrandWordmark({ size = 24, className }: IconProps) {
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{ fontSize: size, lineHeight: 1, fontWeight: 650, letterSpacing: '-0.02em' }}
    >
      Harniverse
    </span>
  )
}
