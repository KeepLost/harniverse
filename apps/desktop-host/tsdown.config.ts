import { defineConfig } from 'tsdown'

/** Private process entry bundles only its app-local providers; workspace capabilities remain external. */
export default defineConfig({
  entry: ['src/index.ts'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
})
