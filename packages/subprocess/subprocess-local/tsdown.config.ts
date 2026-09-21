import { defineConfig } from 'tsdown'

/**
 * Build the public entries as separate single-entry bundles. `index` re-exports
 * through `output` (the shared collector); bundling them together would emit an
 * unlisted shared chunk omitted by the package's exact `files` whitelist, so
 * separate builds inline it.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/output.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
