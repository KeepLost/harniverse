// Hero chrome for the blank-draft phase of ConversationRoot: brand artwork,
// glow backdrop, and the workspace row. Pure presentation — the resident
// composer is NOT rendered here (it keeps its own stable tree position in
// ConversationRoot so the textarea survives the hero → composer flip); CSS
// positions it over this shell's glow area during the hero phase.

import { useId } from 'react'
import type { ReactNode, RefObject } from 'react'
import {
  IconChevronDownOutline14, IconFolderClose16, IconFolderOpen16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceTitleOf } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationSlotProps } from '../contract/slots.ts'
import css from './HeroShell.module.css'

/** The owner's locale seat type, passed to hero chrome as a plain prop. */
type HeroTranslate = ConversationSlotProps['t']

/**
 * Basename label for the workspace chip (the shared derivation);
 * separator-only paths echo the raw cwd.
 * @param cwd - workspace directory path (non-empty).
 * @returns chip label.
 */
export function workspaceLabel(cwd: string): string {
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/**
 * Split workspace chip: the name opens the workbench only for the resolved
 * session Workspace; the arrow keeps the blank-session picker accessible.
 * @param props.label - chip label (see {@link workspaceLabel}); omitted → placeholder.
 * @param props.menuOpen - menu expansion echo.
 * @param props.openDisabled - no resolved session Workspace or a switch is pending.
 * @param props.onPick - menu toggle.
 * @param props.onOpen - workbench opener.
 * @returns the two-button chip.
 */
export function WorkspaceChip({ buttonRef, label, menuOpen = false, openDisabled, onPick, onOpen, t }: {
  buttonRef?: RefObject<HTMLButtonElement>
  label?: string | undefined
  menuOpen?: boolean
  openDisabled: boolean
  onPick: () => void
  onOpen: () => void
  t: HeroTranslate
}) {
  return (
    <div className={css.workspace}>
      <button
        type="button"
        className={css.workspaceName}
        aria-label={t('hero.openWorkbench')}
        title={t('hero.openWorkbench')}
        disabled={openDisabled}
        onClick={onOpen}
      >
        {label === undefined
          ? <IconFolderClose16 className={css.folder} size={16} />
          : <IconFolderOpen16 className={css.folder} size={16} />}
        <span className={css.workspaceLabel}>{label ?? t('hero.chooseWorkspace')}</span>
      </button>
      <button
        ref={buttonRef}
        type="button"
        className={css.workspacePicker}
        aria-label={t('hero.chooseWorkspace')}
        title={t('hero.chooseWorkspace')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onPick}
      >
        <IconChevronDownOutline14 className={css.chevron} size={12} />
      </button>
    </div>
  )
}

/**
 * The soft blue backdrop ellipse (figma 313:14109). Rendered by the hero
 * owner (ConversationRoot), not HeroShell, so it can center on the input
 * card; the owner's className supplies all positioning.
 * @param props.className - positioning class from the owner.
 * @returns the blurred-ellipse svg element.
 */
export function HeroGlow({ className }: { className?: string | undefined }) {
  // Stable filter id so multiple hero mounts do not collide in the DOM.
  const glowFilterId = `empty-glow-${useId().replace(/:/g, '')}`
  return (
    <svg className={className} viewBox="0 0 1051 468" fill="none" aria-hidden="true">
      <defs>
        <filter
          id={glowFilterId}
          x="0"
          y="0"
          width="1051"
          height="468"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur" />
        </filter>
      </defs>
      <g filter={`url(#${glowFilterId})`}>
        <ellipse cx="525.5" cy="234" rx="425.5" ry="134" fill="#6187D8" fillOpacity="0.08" />
      </g>
    </svg>
  )
}

/** Hero chrome props. The workspace row rides the InputBar accessory hole, not here. */
export interface HeroShellProps {
  /** The owner's locale seat, passed down as a plain prop. */
  t: HeroTranslate
  /** Overlay content after the stack (modals). */
  children?: ReactNode
}

/**
 * Render the hero chrome (headline only; no glow, no composer, no workspace
 * row — the glow is the owner's {@link HeroGlow}).
 * @param props - see {@link HeroShellProps}.
 * @returns the centered hero element tree.
 */
export function HeroShell({ t, children }: HeroShellProps) {
  return (
    <div className={css.root}>
      <div className={css.stack}>
        <div className={css.headline}>
          <img
            className={css.brandImage}
            src="/harniverse-brand.png"
            width={260}
            height={260}
            alt="Harniverse brand artwork"
          />
          <div className={css.headlineCopy}>
            <span>{t('hero.headline')}</span>
            <span className={css.previewBadge}>{t('hero.preview')}</span>
          </div>
        </div>
        <div className={css.body}>
          {/* The resident composer (ConversationRoot's root-owned scrollport;
              the workspace row rides the stack above the card) is CSS-centered
              in that scroll body during hero — see
              ConversationRoot.module.css [data-phase='hero']. */}
        </div>
      </div>
      {children}
    </div>
  )
}
