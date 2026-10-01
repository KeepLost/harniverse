import { defineConfig } from 'tsdown'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

function removeBuildMetadata(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) removeBuildMetadata(path)
    else if (entry.name.endsWith('.map') || entry.name.endsWith('.tsbuildinfo')) unlinkSync(path)
  }
}

const outputDirectory = join(import.meta.dirname, 'lib')
if (statSync(outputDirectory, { throwIfNoEntry: false })?.isDirectory()) removeBuildMetadata(outputDirectory)

export default defineConfig({
  entry: ['lib/types/{bin,index,invariant,composition}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
