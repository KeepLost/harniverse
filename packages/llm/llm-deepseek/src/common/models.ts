/** Default catalog shared by every DeepSeek protocol. */

import type { DeepSeekCatalogModel } from './types.ts'

/** Default official model entries; deployments may replace the catalog. */
export const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V41-Flash',
    contextWindow: 1_000_000,
    inputModalities: ['text', 'image'],
    systemPromptUpdate: 'in-history',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    contextWindow: 1_000_000,
  },
]
