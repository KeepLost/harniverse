import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { vitestExecArgv } from '../../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/ssh/remote-hosts-ssh/tests/**/*.spec.ts'],
    pool: 'forks', maxWorkers: 1, execArgv: vitestExecArgv,
    testTimeout: 10_000, hookTimeout: 10_000,
  },
})
