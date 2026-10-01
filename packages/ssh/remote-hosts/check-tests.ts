/** Source-plane package/test check, including newly staged peers without changing their build outputs. */
import ts from 'typescript'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const file = join(import.meta.dirname, 'tsconfig.tests.json')
const config = ts.readConfigFile(file, ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, import.meta.dirname)
const options = { ...parsed.options, rootDir: root, paths: { ...parsed.options.paths,
  '@deepseek-ai/dsh-remote-runtime': [join(root, 'packages/ssh/remote-runtime/src/index.ts')],
  '@deepseek-ai/dsh-credentials-encrypted': [join(root, 'packages/credentials/credentials-encrypted/src/index.ts')],
} }
const references = parsed.projectReferences?.filter(reference =>
  !reference.path.endsWith('/remote-runtime') && !reference.path.endsWith('/credentials-encrypted')) ?? []
const program = ts.createProgram({ rootNames: parsed.fileNames, options, projectReferences: references })
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: path => path, getNewLine: () => '\n',
  }))
  process.exitCode = 1
} else console.log('remote-hosts source and tests: typecheck passed')
