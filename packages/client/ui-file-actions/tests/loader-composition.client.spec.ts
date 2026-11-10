// @vitest-environment jsdom
/**
 * REAL-composition boot: the plugin loads through the cordis Loader from a
 * cordis.yml alongside a locale provider, and its capability service and
 * dictionary registration become visible to sibling consumers.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { apply as applyFileActions, inject as fileActionsInject } from '../src/client/index.ts'
import type { FileActions } from '../src/types.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('ui-file-actions through a real Loader composition', () => {
  it('provides the capability and registers its dictionary beside a locale provider', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-file-actions-loader-'))
    const registered: string[] = []
    const captured: { service: FileActions | undefined } = { service: undefined }
    const localeProvider = {
      name: 'test-locale',
      apply(localeCtx: Context): void {
        localeCtx.provide('locale', {
          register: (ns: string) => {
            registered.push(ns)
            return () => {}
          },
        })
        localeCtx.provide('contextMenus', { register: () => () => {}, notify: () => {} } as never)
        localeCtx.provide('slots', {
          inject: (_name: string, register: Parameters<SlotRegistry['inject']>[1]) => localeCtx.effect(register),
          register: () => () => {},
        } as never)
        localeCtx.provide('workspaces', { list: { getSnapshot: () => ({ items: [] }) } } as never)
      },
    }
    const consumer = {
      name: 'test-consumer',
      inject: ['fileActions'],
      apply(consumerCtx: Context): void {
        captured.service = consumerCtx.get('fileActions')
      },
    }
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: test-locale',
      '- name: test-file-actions',
      '- name: test-consumer',
      '',
    ].join('\n'))

    ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === 'test-locale') return localeProvider
        if (specifier === 'test-consumer') return consumer
        if (specifier === 'test-file-actions') return { inject: fileActionsInject, apply: applyFileActions }
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    for (const row of ctx.loader.entries()) {
      if (row.fiber !== undefined) await row.fiber.await()
    }
    const failed = [...ctx.loader.entries()].filter(row => !row.disabled && row.fiber?.state === FiberState.FAILED)
    expect(failed.map(row => row.options.name)).toEqual([])
    expect(registered).toEqual(['fileActions'])
    expect(captured.service?.canSaveAs).toBe(false)
    await expect(captured.service?.save({ url: 'file:///etc/hosts' }, 'saveAs')).rejects.toThrow('requires Desktop')
  })
})
