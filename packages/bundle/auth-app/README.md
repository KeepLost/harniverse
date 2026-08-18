# `@deepseek-ai/dsh-auth-app`

English | [中文](README.zh.md)

The one-shot local Grant management bundle. `dsh auth` boots this profile and forwards the remaining arguments to `auth-startup`, which owns the `device`, `grant`, and `client` command groups. The injected `auth-runner` approves pending device enrollments, lists or revokes Grants, registers API-client public keys, and requests bounded exit through the launcher-provided `ctx.appExit`.

The bundle does not mount `dsh-authentication-local` as a network service or open a port. It therefore approves the first owner device in a sealed Harness home without requiring an existing credential.

## Model Experience

None, as this one-shot management app neither creates an Agent nor contributes model context.

#### KV Cache effect

None; the bundle performs no model request.

## Known Limitations and Deferred Work

- The app manages only the local Grant Provider; alternate authentication Providers own their own management commands.
