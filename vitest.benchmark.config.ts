import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/** Linux benchmark inventory; individual samples remain serial within a file. */
export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: ['./tsconfig.base.json'] }),
    standardDecoratorPlugin(),
  ],
  test: {
    execArgv: [...vitestExecArgv, '--expose-gc'],
    include: ['benchmarks/**/*.bench.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    disableConsoleIntercept: true,
    hookTimeout: 120_000,
    testTimeout: 180_000,
  },
})
