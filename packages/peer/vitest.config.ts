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
    '@deepseek-ai/cordis': new URL('../../vendor/cordis/src/index.ts', import.meta.url).pathname,
    '@deepseek-ai/cosmokit': new URL('../../vendor/cosmokit/src/index.ts', import.meta.url).pathname,
    '@deepseek-ai/schemastery': new URL('../../vendor/schemastery/src/index.ts', import.meta.url).pathname,
    '@deepseek-ai/cordis-plugin-loader': new URL('../../vendor/loader/src/index.ts', import.meta.url).pathname,
    '@deepseek-ai/cordis-plugin-include': new URL('../../vendor/include/src/index.ts', import.meta.url).pathname,
  } },
  test: { include: ['packages/peer/*/tests/**/*.spec.ts'], pool: 'forks', maxWorkers: 1, execArgv: vitestExecArgv, testTimeout: 30_000 },
})
