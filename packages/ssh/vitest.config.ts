import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

const dependencies = createRequire(new URL('../mcp/mcp-client/package.json', import.meta.url))

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  resolve: { alias: {
    'esbuild': createRequire(realpathSync(new URL('../../node_modules/tsx/package.json', import.meta.url))).resolve('esbuild'),
    'zod': dependencies.resolve('zod'),
    '@modelcontextprotocol/sdk': new URL('../mcp/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm', import.meta.url).pathname,
    '@deepseek-ai/dsh-ssh/protocol': new URL('./ssh/src/protocol.ts', import.meta.url).pathname,
    '@deepseek-ai/dsh-ssh/schemas': new URL('./ssh/src/schemas.ts', import.meta.url).pathname,
    '@deepseek-ai/dsh-ssh': new URL('./ssh/src/index.ts', import.meta.url).pathname,
  } },
  test: { include: ['packages/ssh/*/tests/**/*.spec.ts'], pool: 'forks', maxWorkers: 1, execArgv: vitestExecArgv, testTimeout: 30_000 },
})
