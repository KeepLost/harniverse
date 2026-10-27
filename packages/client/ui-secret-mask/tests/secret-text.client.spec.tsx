// @vitest-environment jsdom
/** Masked presentation with the per-value reveal control. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretText } from '../src/client/SecretText.tsx'
import { createSecretRule } from '../src/client/secret-rule.tsx'

afterEach(() => {
  cleanup()
})

const t = (key: 'secret.reveal' | 'secret.hide'): string => (key === 'secret.reveal' ? 'Show secret' : 'Hide secret')

/** A prefixed key's masked form: first eight characters kept, the rest masked. */
const RAW = 'sk-0123456789abcdefghijklmnopqrstuv'
const MASKED = `${RAW.slice(0, 8)}${'*'.repeat(RAW.length - 8)}`

function secret(interactive: boolean): HTMLElement {
  return render(
    <SecretText raw={RAW} interactive={interactive} data={{ masked: MASKED }} t={t} />,
  ).container.querySelector('[data-secret]') as HTMLElement
}

describe('SecretText', () => {
  it('draws the masked form and keeps the original characters out of the document', () => {
    const element = secret(true)
    expect(element.textContent).toBe(MASKED)
    expect(element.textContent).not.toContain(RAW)
    expect(screen.getByRole('button', { name: t('secret.reveal') })).toBeTruthy()
  })

  it('reveals and hides one value through the control', () => {
    const element = secret(true)
    fireEvent.click(screen.getByRole('button', { name: t('secret.reveal') }))
    expect(element.textContent).toContain(RAW)
    fireEvent.click(screen.getByRole('button', { name: t('secret.hide') }))
    expect(element.textContent).not.toContain(RAW)
  })

  it('draws no control in non-interactive text', () => {
    const element = secret(false)
    expect(element.querySelector('button')).toBeNull()
    expect(element.textContent).toBe(MASKED)
  })

  it('starts masked again for a different value at the same position', () => {
    const { rerender } = render(
      <SecretText raw={RAW} interactive data={{ masked: MASKED }} t={t} />,
    )
    fireEvent.click(screen.getByRole('button', { name: t('secret.reveal') }))
    const other = 'ghp_0123456789abcdefghijklmnopqrstuv'
    rerender(<SecretText raw={other} interactive data={{ masked: `${other.slice(0, 8)}${'*'.repeat(other.length - 8)}` }} t={t} />)
    expect(screen.queryByText(RAW)).toBeNull()
    expect(screen.getByRole('button', { name: t('secret.reveal') })).toBeTruthy()
  })

  it('falls back to drawing the raw characters when the seam carries no prepared form', () => {
    const element = render(<SecretText raw={RAW} interactive={false} data={undefined} t={t} />)
      .container.querySelector('[data-secret]') as HTMLElement
    expect(element.textContent).toBe(RAW)
  })

  it('renders through the rule Render component over the seam props', () => {
    const rule = createSecretRule(t)
    const match = rule.nextMatch(`x ${RAW} y`, 0)
    expect(match).toBeDefined()
    const element = render(
      <rule.Render raw={RAW} interactive data={match?.data} />,
    ).container.querySelector('[data-secret]') as HTMLElement
    expect(element.textContent).toBe(MASKED)
  })
})
