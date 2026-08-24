/** Client-safe declarations owned by the agent-profile domain. */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Agent Profile roster or composition topology changed; consumers refetch their projection. @mode emit */
    'agent-presets/change'(): void
  }
}

export {}
