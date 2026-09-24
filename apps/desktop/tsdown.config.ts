import { defineConfig } from 'tsdown'

/** Build the Electron main entry as ESM and the sandbox preload as CommonJS. */
export default defineConfig([
  {
    entry: ['src/entry.ts'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
    external: ['electron'],
  },
  {
    entry: ['src/preload.ts'], outDir: 'lib', format: ['cjs'], platform: 'node', target: 'es2024',
    fixedExtension: true, outputOptions: { codeSplitting: false }, dts: false, clean: false,
    external: ['electron'],
  },
])
