import { defineConfig } from 'tsdown'

/**
 * Build the public entry and its invariant companion in one multi-entry pass;
 * with no sibling modules there is no shared chunk to whitelist.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
