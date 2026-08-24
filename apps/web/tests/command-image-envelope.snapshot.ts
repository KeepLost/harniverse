// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

async function freshComposer(): Promise<HTMLTextAreaElement> {
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  const start = tree.querySelector<HTMLButtonElement>('button[aria-label="New session in fixture"]')
  if (start === null) throw new Error('fixture Workspace new-session action missing')
  fireEvent.click(start)
  return await screen.findByPlaceholderText('Describe what you want to build', {}, { timeout: 10_000 }) as HTMLTextAreaElement
}

async function pasteImage(textarea: HTMLTextAreaElement, name: string): Promise<void> {
  const image = new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
  fireEvent.paste(textarea, {
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      getData: () => '',
    },
  })
  await waitFor(() => {
    const rail = document.querySelector('[role="group"][aria-label="Pending images"]')
    expect([...rail!.querySelectorAll('img')].map(img => img.getAttribute('alt'))).toContain(name)
  })
}

it('refuses unsupported command images and retains the complete composer envelope', async () => {
  mountAssembledApp()
  const textarea = await freshComposer()
  await pasteImage(textarea, 'ref.png')
  fireEvent.change(textarea, { target: { value: '/echo hello' } })
  fireEvent.keyDown(textarea, { key: 'Enter' })

  const notice = await waitFor(() => {
    const match = [...document.querySelectorAll('[role="status"]')]
      .find(candidate => candidate.textContent?.includes('image attachments') ?? false)
    if (match === undefined) throw new Error('composer refusal notice missing')
    return match
  }, { timeout: 5_000 })
  expect(notice.textContent).toBe('/echo does not accept image attachments; remove them first')
  expect(textarea.value).toBe('/echo hello')
  expect(document.querySelector('[role="group"][aria-label="Pending images"]')).not.toBeNull()
})

it('submits image-only /plan and releases its browser draft image after success', async () => {
  mountAssembledApp()
  const textarea = await freshComposer()
  await pasteImage(textarea, 'plan.png')
  fireEvent.change(textarea, { target: { value: '/plan' } })
  fireEvent.keyDown(textarea, { key: 'Enter' })

  await waitFor(() => {
    const failure = [...document.querySelectorAll('[role="status"]')]
      .map(candidate => candidate.textContent ?? '')
      .find(text => text.includes('command.execute') || text.includes('/plan'))
    if (failure !== undefined) throw new Error(`plan command failed: ${failure}`)
    expect(textarea.value).toBe('')
    expect(document.querySelector('[role="group"][aria-label="Pending images"]')).toBeNull()
  }, { timeout: 5_000 })
})
