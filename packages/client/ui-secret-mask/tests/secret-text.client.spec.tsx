// @vitest-environment jsdom
/** Masked presentation with the per-value reveal control. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretText } from '../src/client/SecretText.tsx'

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
})
