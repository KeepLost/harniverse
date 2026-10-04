// ApprovalPanel: the composer-takeover approval prompt (designer draft
// approval.png), registered as a selector-routed entry of the
// conversation-declared composer chain. While an approval question is
// pending, this panel occupies the composer slot in place of the InputBar:
// an amber "Waiting for approval" strip on the card top, the model's
// justification as the headline, the paired command in muted code text, and
// a right-aligned refuse/allow action row. Justification and command are
// unbounded model text, so they scroll inside the card at the shared composer
// cap (`data-approval-scroll`) and the action row stays outside it — the
// buttons must be reachable no matter how long the command is.
// One-shot: the buttons disable after a click and the panel leaves (the
// InputBar returns) on the broadcast resolved frame. Keyboard parity with
// the buttons: Enter allows once and Escape rejects while focus stays in
// the panel, with IME composition and native button-Enter clicks left to
// their own owners.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RunningToolCall } from '@deepseek-ai/dsh-client-runtime/client'
import { PendingApproval, type ApprovalComposerProps } from '../contract/slots.ts'
import { rootToolCall } from './tool-node-reader.ts'
import css from './ApprovalPanel.module.css'

/** Extract the shell command from an approval's paired running call (bash-family args carry `command`); undefined hides the line. */
export function commandOf(call: RunningToolCall | undefined): string | undefined {
  if (call === undefined) return undefined
  try {
    const args = JSON.parse(call.argsRaw) as Record<string, unknown>
    return typeof args.command === 'string' ? args.command : undefined
  } catch {
    // Unparseable model args: the panel still renders, just without the command line.
    return undefined
  }
}

/**
 * Composer takeover boundary: mints the domain face on the carrier's stable
 * identity and remounts the flow per request key, so the one-shot answered
 * latch never leaks to the next pending approval.
 * @param props - the selector-matched pending approval carrier plus the framework standard kit.
 * @returns The approval prompt for this request.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = useMemo(() => new PendingApproval(props.matched), [props.matched])
  const command = props.useSession((snapshot) => {
    if (approval.callId === undefined) return undefined
    const root = rootToolCall(snapshot, approval.callId)
    if (root === undefined) return undefined
    return root.callId === approval.callId && !('kind' in root) ? commandOf(root) : undefined
  })
  return <ApprovalFlow key={approval.key} pending={approval} t={props.t} {...command === undefined ? {} : { command }} />
}

function ApprovalFlow({ pending, command, t }: {
  pending: PendingApproval
  command?: string
  t: ApprovalComposerProps['t']
}) {
  // Local one-shot latch: the panel leaves only when the resolved frame
  // lands; until then the buttons must not re-fire. An answer failure
  // (rejected receipt / transport) re-arms them for retry. The waiting ref
  // holds the latch across synchronous key repeats and double keydowns that
  // race the re-render; `active` keeps a late failure from re-arming a
  // panel that already left.
  const [answered, setAnswered] = useState(false)
  const waiting = useRef(false)
  const active = useRef(true)
  const composing = useRef(false)
  const compositionEnded = useRef(false)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    if (waiting.current) return
    waiting.current = true
    setAnswered(true)
    void pending.answer(outcome).catch(() => {
      if (!active.current) return
      waiting.current = false
      setAnswered(false)
    })
  }
  // Panel-level keys: Enter allows once, Escape rejects — only while focus
  // stays inside the panel, never from editable descendants, and never on
  // behalf of a button (its native Enter click owns that path).
  const keydown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const element = event.target as Element
    if (event.defaultPrevented || !event.currentTarget.contains(document.activeElement)
      || element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null) return
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    if (event.key === 'Enter' && element.closest('button, a[href], [role="button"]') !== null) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
    if (event.repeat || composing.current || compositionEnded.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    answer(event.key === 'Enter' ? 'allowed-once' : 'rejected')
  }
  return (
    <div
      className={css.root}
      data-approval-key={pending.key}
      aria-busy={answered}
      onKeyDown={keydown}
      onKeyUpCapture={() => { compositionEnded.current = false }}
      onCompositionStartCapture={() => { composing.current = true }}
      onCompositionEndCapture={() => { composing.current = false; compositionEnded.current = true }}
    >
      <div className={css.card}>
        <div className={css.strip}><span className={css.dot} />{t('approval.waiting')}</div>
        {/* Tab stop: the region scrolls once the command passes the cap and
            holds nothing focusable of its own, so without one a keyboard-only
            user cannot reach the command's tail before answering. */}
        <div className={css.body} data-approval-scroll="" tabIndex={0} role="group" aria-label={t('approval.detail.aria')}>
          <div className={css.headline}>{pending.reason ?? t('approval.escalation', { toolName: pending.toolName })}</div>
          {command !== undefined && <div className={css.command}>{command}</div>}
        </div>
        <div className={css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={answered} onClick={() => { answer('rejected') }}>
            {t('approval.reject')}
          </Button>
          <Button variant="primary" disabled={answered} onClick={() => { answer('allowed-once') }}>
            {t('approval.allowOnce')}
          </Button>
        </div>
      </div>
    </div>
  )
}
