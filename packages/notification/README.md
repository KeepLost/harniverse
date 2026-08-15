# notification/ — outbound event delivery

English | [中文](README.zh.md)

This family projects selected Harness lifecycle facts into a stable external protocol and delegates delivery to an explicitly configured backend. It is host-only, opt-in, and independent of model request assembly.

| Package | Role | ctx key |
|---|---|---|
| [`notification/`](notification/README.md) | Defines the versioned envelope, event vocabulary, JSON snapshot, and backend handoff | `ctx.notification` |
| [`notification-http/`](notification-http/README.md) | Persists, filters, and delivers events to configured HTTP or HTTPS endpoints | `ctx.notification` provider; consumes `ctx.storageDomain` |
