import { defineConfig } from 'tsdown'

/**
 * Build the index and child as separate single-entry bundles. The sibling `child.cjs` is loaded
 * by file path in a fresh process and must be CommonJS for pkg's VFS child-process hook. A
 * multi-entry build emits an unlisted shared chunk omitted by the package's exact `files`
 * whitelist; separate builds inline it.
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
    entry: ['lib/types/child.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
