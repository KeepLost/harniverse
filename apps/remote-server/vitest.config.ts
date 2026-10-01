import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../vitest.shared.ts'

// Scoped verification also works before the coordinator adds workspace aliases.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  resolve: {
    alias: {
      '@deepseek-ai/dsh-credentials-encrypted': fileURLToPath(new URL('../../packages/credentials/credentials-encrypted/src/index.ts', import.meta.url)),
      '@deepseek-ai/dsh-remote-runtime': fileURLToPath(new URL('../../packages/ssh/remote-runtime/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/ssh/remote-runtime/tests/**/*.spec.ts', 'apps/remote-server/tests/**/*.spec.ts', 'scripts/build-remote-server.spec.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    execArgv: vitestExecArgv,
    testTimeout: 30_000,
  },
})
