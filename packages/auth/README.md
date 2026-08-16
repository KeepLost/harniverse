# Authentication packages

English | [中文](README.zh.md)

Inbound network authentication is one process-wide capability. The Service Definition authenticates HTTP and WebSocket admission; the local provider owns named tokens, browser sessions, the per-home network-instance lease, and access records.

| Package | Role | `ctx` key |
|---|---|---|
| [`authentication`](authentication/README.md) | Service Definition and revocation event | `authentication` |
| [`authentication-local`](authentication-local/README.md) | Named-token provider, browser sessions, lease, and access log | `authentication` |
