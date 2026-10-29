import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  runLoaderSmoke,
} from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/subagent/subagent-oar/',
  import.meta.url,
))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'cordis.yml')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('OAR provider public Loader composition', () => {
  it('loads both OAR providers and the runtime-selection tool without probing or starting installed agents', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'subagent-oar Loader composition',
      tempDirPrefix: 'dsh-oar-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: {
        // Loading must not probe or start either native agent.
        PATH: '',
        OAR_CODEX_BIN: '/missing-oar-loader-codex',
        OAR_CLAUDE_BIN: '/missing-oar-loader-claude',
      },
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      providers: [
        {
          name: 'oar-codex',
          capabilities: {
            outputSchema: false,
            depthLimit: false,
            toolFilter: false,
            persona: false,
          },
          inheritsParentContext: false,
        },
        {
          name: 'oar-claude',
          capabilities: {
            outputSchema: false,
            depthLimit: false,
            toolFilter: false,
            persona: false,
          },
          inheritsParentContext: false,
        },
      ],
      tools: [
        {
          name: 'subagent_oar',
          parameterNames: ['description', 'prompt', 'runtime'],
          required: ['runtime', 'description', 'prompt'],
        },
      ],
      starts: 0,
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
