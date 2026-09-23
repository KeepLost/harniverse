/** Install the sealed physical runtime after electron-builder's dependency filtering. */
module.exports = async function afterPack(context) {
  const { cpSync, realpathSync, rmSync } = require('node:fs')
  const { isAbsolute, join, relative, resolve, sep } = require('node:path')
  const { checkRuntime } = await import('./packaging-runtime.ts')
  const root = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app')
    : join(context.appOutDir, 'resources', 'app')
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
  if (!arch) throw new Error(`Unsupported packaged architecture: ${context.arch}`)
  const source = realpathSync(context.packager.info.appDir)
  const output = resolve(context.appOutDir)
  const rel = relative(output, source)
  if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) throw new Error('Sealed input must be outside the builder output')
  const original = checkRuntime(source, context.electronPlatformName, arch)
  if (original.errors.length) throw new Error(`Invalid sealed runtime: ${original.errors.slice(0, 10).join('\n')}`)
  rmSync(root, { recursive: true, force: true })
  cpSync(source, root, { recursive: true, dereference: false, preserveTimestamps: true })
  const result = checkRuntime(root, context.electronPlatformName, arch)
  if (result.errors.length) throw new Error(`Packaged runtime verification failed (${result.errors.length} errors):\n${result.errors.slice(0, 10).join('\n')}`)
}
