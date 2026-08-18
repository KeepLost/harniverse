# Authentication packages

English | [中文](README.zh.md)

Inbound authentication is one process-wide capability. The Service Definition carries principals and endpoint capabilities; the local Provider owns public-key Grants, signed challenges, short process-memory credentials, the per-home network-instance lease, and access records.

| Package | Role | `ctx` key |
|---|---|---|
| [`authentication`](authentication/README.md) | Service Definition and revocation event | `authentication` |
| [`authentication-local`](authentication-local/README.md) | Public-key Grants, challenges, short credentials, lease, and access log | `authentication` |
