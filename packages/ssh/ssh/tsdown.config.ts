import { defineConfig } from 'tsdown'

/**
 * Build the connection entry, its wire protocol, the strict schemas, and the
 * installed helper as ONE multi-entry build: index and helper both reach the
 * protocol and schema modules, and a direct `@deepseek-ai/dsh-ssh/protocol`
 * import must observe the SAME module instances (RemoteOperationError
 * instanceof) as the bundled connection — separate builds would inline
 * competing copies. Shared chunks land in the files-whitelisted
 * `lib/<module>-*.js` companions.
 */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    invariant: 'lib/types/invariant.js',
    protocol: 'lib/types/protocol.js',
    schemas: 'lib/types/schemas.js',
    helper: 'lib/types/helper-entry.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
