/**
 * Checkout-root context behavior: the registered paragraph and its order,
 * single-contribution ownership, the root derivation both entry planes share,
 * and fiber disposal.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as HarnessSource from '../src/index.ts'

describe('harness-source', () => {
  it('registers the checkout-root context with the pwd-separation contract', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { persona: 'You are a coding agent.' })
      await ctx.plugin(HarnessSource)
      const assembly = await ctx.systemPrompt.assemble()
      const context = assembly.contexts.find(entry => entry.name === HarnessSource.HARNESS_SOURCE_CONTEXT)
      expect(context?.text).toBe(`The Harniverse implementation checkout is at ${HarnessSource.HARNESS_SOURCE_ROOT}. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend Harniverse itself.`)
      // The DSH relationship and third-party disclaimer live in the harness
      // identity opener, not in this context.
      expect(context?.text).not.toContain('downstream')
      expect(context?.text).not.toContain('NOT affiliated')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('owns exactly one contribution: the system-prompt baseline sections and contexts only', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { persona: 'You are a coding agent.' })
      await ctx.plugin(HarnessSource)
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.sections.map(entry => entry.name)).toEqual(['harness:identity'])
      expect(assembly.contexts.map(entry => entry.name))
        .toEqual([HarnessSource.HARNESS_SOURCE_CONTEXT, 'deployment:persona'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('derives the repository root identically from its own entry and a test-file derivation', () => {
    // Snapshot normalization replaces the repository root wholesale, so the
    // package derivation must stay string-identical to an equal-depth one.
    expect(HarnessSource.HARNESS_SOURCE_ROOT).toBe(fileURLToPath(new URL('../../../..', import.meta.url)))
    expect(existsSync(join(HarnessSource.HARNESS_SOURCE_ROOT, 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('disposes with its fiber, so an HMR reload leaves no residue', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { persona: 'You are a coding agent.' })
      const fiber = await ctx.plugin(HarnessSource)
      const present = await ctx.systemPrompt.assemble()
      expect(present.contexts.some(entry => entry.name === HarnessSource.HARNESS_SOURCE_CONTEXT)).toBe(true)
      await fiber.dispose()
      const gone = await ctx.systemPrompt.assemble()
      expect(gone.contexts.some(entry => entry.name === HarnessSource.HARNESS_SOURCE_CONTEXT)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
