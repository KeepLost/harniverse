import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { resolve } from 'node:path'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  resolve: { alias: {
    '@deepseek-ai/dsh-remote-hosts-ssh': resolve('packages/ssh/remote-hosts-ssh/src/index.ts'),
    '@deepseek-ai/dsh-credentials-encrypted': resolve('packages/credentials/credentials-encrypted/src/index.ts'),
    '@deepseek-ai/dsh-remote-runtime': resolve('packages/ssh/remote-runtime/src/index.ts'),
  } },
  test: { include: ['packages/ssh/remote-hosts/tests/**/*.spec.ts'], pool: 'forks', maxWorkers: 1,
    execArgv: vitestExecArgv, testTimeout: 15_000, hookTimeout: 15_000 },
})
