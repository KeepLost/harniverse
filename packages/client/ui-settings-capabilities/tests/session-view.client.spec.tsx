// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { SessionCapabilitiesView } from '../src/client/SessionCapabilitiesView.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

describe('SessionCapabilitiesView', () => {
  it('renders the immutable Profile generation and actual assembly statuses', async () => {
    const load = vi.fn(async () => ({
      sessionId: 'session-1',
      agentProfile: 'standard',
      generation: 'standard@3',
      entries: [{
        id: 'plugin:tool-bash',
        kind: 'tool' as const,
        name: 'tool-bash',
        description: 'Profile plugin tool-bash',
        provenance: 'upstream' as const,
        assembleable: true,
        available: true,
        defaultLoaded: true,
        manageable: true,
        owner: '@deepseek-ai/dsh-tool-bash',
        requires: [],
        selection: 'inherit' as const,
        effectiveSelection: 'load' as const,
        selected: true,
        status: 'loaded' as const,
      }],
    }))
    const props = { load, t: (key: keyof typeof en) => en[key] } as unknown as ComponentProps<typeof SessionCapabilitiesView>
    render(<SessionCapabilitiesView {...props} />)

    await waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    expect(await screen.findByText('standard@3')).toBeTruthy()
    expect(screen.getByText(en.statusLoaded)).toBeTruthy()
    expect(screen.getByText('tool-bash')).toBeTruthy()
  })
})
