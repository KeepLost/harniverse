/** Profile schema generation: composition diagnostics and boot-free discovery. */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, type Profile } from '../profile.ts'
import { collectConfigSchemas } from './collect.ts'
import type { ConfigSchemaDiagnostic, ConfigSchemaDump } from './types.ts'
export type { ConfigSchemaDump, NativeConfigSchema } from './types.ts'

/**
 * Generate JSON Schema for a prepared profile's ordered patch layers without mounting plugins or evaluating expressions.
 * Imports, Config getters, and lazy builders execute trusted code. Native validators and
 * transform callbacks are not executed. Supplied layers are not mutated.
 * Profile preparation, layer selection, process streams, and exit policy belong to the caller.
 * @param profile - prepared on-disk profile whose directory anchors root module and include resolution.
 * @param layers - already parsed patch lists in application order, including caller-selected home and argv overlays.
 * @returns a JSON Schema document with declaration references, partial results, and diagnostics under `x-cordis`.
 */
export async function generateConfigSchema(
  profile: Profile,
  layers: readonly PatchOptions[][],
): Promise<ConfigSchemaDump> {
  const diagnostics: ConfigSchemaDiagnostic[] = []
  const entries = composeEntries(layers, message => diagnostics.push({ level: 'warning', message }))
  return collectConfigSchemas(profile, entries, diagnostics)
}
