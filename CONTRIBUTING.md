# Contributing

English | [中文](CONTRIBUTING.zh.md)

Harniverse welcomes issue reports, documentation corrections, plugin experiments, and pull requests. A submitted pull request is an invitation to review, not a promise to merge: acceptance depends on project scope, architecture fit, verification, and the maintainers' capacity to support the result.

## Before proposing a change

- Search [Harniverse Issues](https://github.com/KeepLost/harniverse/issues) before opening a duplicate. Use an issue to align on substantial product, security, distribution, or architecture changes before implementation.
- Read [AGENTS.md](AGENTS.md) for repository workflow and invariants, and [PLUGINS.md](PLUGINS.md) for the official DeepSeek Harness baseline and every Harniverse downstream capability or composition change.
- Preserve **everything is a plugin**. Extend documented plugin services and complete Definition, Provider, and Consumer roles instead of adding launcher, loop, or bundle special cases.
- Keep inherited `@deepseek-ai/dsh-*` names and upstream attribution unless an approved distribution decision changes them.

## Prepare a pull request

Keep one change focused and include the tests, bilingual documentation, generated artifacts, and Agent Note required by that change. Follow the [development guide](docs/development.md) for setup and daily commands; select checks through the workflow in [AGENTS.md](AGENTS.md#run-relevant-checks-locally) rather than treating one broad command as proof for every surface.

Describe the observable result, important design boundaries, commands actually run, and any remaining failure or environment gap. Do not include credentials, private endpoints, generated secrets, or unrelated formatting churn.

Harniverse is pre-release software without a tagged compatibility commitment. A contribution may update all affected callers and persisted fixtures instead of adding speculative compatibility code, but it must preserve explicit authentication, authorization, TLS, and plugin-native ownership boundaries.

## Contribute to the plugin ecosystem

Plugins do not need to live in this repository to be useful. Publish independent plugins when their lifecycle and release cadence do not belong to Harniverse, add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic for discovery, and document the Harniverse or upstream DSH versions and capabilities they require.

Harniverse derives from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Contributions to this repository are Harniverse contributions and do not represent acceptance, support, or endorsement by DeepSeek AI.
