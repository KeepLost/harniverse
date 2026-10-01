/** Package-only generation while shared aggregate integration is owned separately. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'

const directory = import.meta.dirname
const root = resolve(directory, '../../..')
const workspace = new WorkspaceAnalyzer({ root, hostConfig: join(directory, 'tsconfig.host.json'),
  faces: ['host'], packages: ['@deepseek-ai/dsh-remote-hosts'], checkDiagnostics: false }).analyze()
const face = workspace.faces[0]
if (!face) throw new Error('remote-hosts: missing Host face')
const artifact = new FaceModelEmitter(face).emit('@deepseek-ai/dsh-remote-hosts')
if (!artifact.remote) throw new Error('remote-hosts: missing Remote artifact')
await mkdir(join(directory, 'lib'), { recursive: true })
for (const [name, content] of Object.entries({
  'typert.host.js': artifact.js, 'typert.host.d.ts': artifact.dts,
  'typert.remote-client.js': artifact.remote.js, 'typert.remote-client.d.ts': artifact.remote.dts,
  'typert.remote-client.d.ts.map': artifact.remote.dtsMap,
})) await writeFile(join(directory, 'lib', name), content)
