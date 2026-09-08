import { clientOnly } from '../tsdown.client.ts'

export default clientOnly([{
  entry: { index: 'lib/types/index.js', invariant: 'lib/types/invariant.js' },
  outDir: 'lib', format: ['esm'], platform: 'neutral', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
}])
