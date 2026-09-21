import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'lib/types/index.js', consumer: 'lib/types/consumer.js', helper: 'lib/types/helper-entry.js',
    protocol: 'lib/types/protocol.js', schemas: 'lib/types/schemas.js', invariant: 'lib/types/invariant.js' },
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
})
