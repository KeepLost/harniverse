# `@deepseek-ai/dsh-auth-app`

English | [中文](README.zh.md)

The one-shot authentication management bundle. `dsh auth` boots this profile and forwards the remaining arguments to `auth-startup`, which owns the `token add`, `token reset`, `token delete`, and `token list` grammar. The injected `auth-runner` calls the local named-token management API, writes generated secrets only for add and reset, and requests bounded exit through the launcher-provided `ctx.appExit`.

The bundle does not mount `dsh-authentication-local` as a network authentication service, open a port, or require an existing token. It can therefore create the first token in an empty Harness home.

## Model Experience

None, as this one-shot management app neither creates an Agent nor contributes model context.

#### KV Cache effect

None; the bundle performs no model request.

## Known Limitations and Deferred Work

- The app manages only the local named-token Provider; alternate authentication Providers own their own management surfaces.
