/**
 * Known ACP agents: how each is launched over stdio, where it reads a
 * credential, and how a person signs in. Data only; the protocol path uses
 * none of it unless a consumer names one.
 * @module @deepseek-ai/dsh-acp-client/catalog
 */

/** One ACP agent this client knows how to launch. */
export interface AcpKnownAgent {
  readonly id: string
  readonly name: string
  /** Executable that serves the agent over stdio. */
  readonly command: string
  /** Arguments passed to {@link AcpKnownAgent.command}. */
  readonly args: readonly string[]
  /** Environment variables the agent reads an API key from. */
  readonly credentialEnv: readonly string[]
  /** How a person signs in, in one sentence. */
  readonly signIn: string
  /** Exact `agentInfo.name` values the agent reports at the handshake. */
  readonly agentNames: readonly string[]
}

/** The agents this client knows, in the order of the official registry. */
export const KNOWN_AGENTS: readonly AcpKnownAgent[] = [
  {
    id: 'claude-acp',
    name: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    credentialEnv: ['ANTHROPIC_API_KEY'],
    signIn: 'A terminal login the adapter offers (`--cli auth login` for a Claude subscription or the Anthropic Console); a session opens before it and the first prompt is refused until it is done.',
    agentNames: ['@agentclientprotocol/claude-agent-acp'],
  },
  {
    id: 'codex-acp',
    name: 'Codex',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    credentialEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
    signIn: 'An API key the adapter reads from the environment, or a ChatGPT login it opens in the browser.',
    agentNames: ['@agentclientprotocol/codex-acp'],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'npx',
    args: ['-y', '@google/gemini-cli', '--acp'],
    credentialEnv: ['GEMINI_API_KEY'],
    signIn: 'A Google account the CLI opens in the browser, or a Gemini API key.',
    agentNames: [],
  },
  {
    id: 'antigravity-acp',
    name: 'Google Antigravity',
    command: 'agy',
    args: ['acp'],
    credentialEnv: ['GEMINI_API_KEY'],
    signIn: 'A Google account, a Gemini Enterprise account, or a Gemini API key, each through the agent itself; `agy acp --login` completes one outside the harness.',
    agentNames: ['antigravity-acp'],
  },
]

/**
 * Find a known agent by id.
 * @param id - the catalog id.
 * @returns the agent, or `undefined` when none carries that id.
 */
export function knownAgent(id: string): AcpKnownAgent | undefined {
  return KNOWN_AGENTS.find(agent => agent.id === id)
}
