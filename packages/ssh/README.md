# SSH execution providers

English | [中文](README.zh.md)

These packages run a selected execution Profile on a trusted POSIX machine over OpenSSH. The Host keeps Agent identity, model access, Session authority, credentials, and the SSH connection. The execution machine owns its MCP, Skill, and Hook configuration.

`dsh-ssh` verifies the bundled helper digest before import, captures the immutable remote Profile selection, reports a digest-verified execution-world descriptor, and tears down the helper lease and managed process ranges when the connection closes. The `cordis` preset is rejected by the descriptor contract.

The filesystem, subprocess, sandbox, and terminal providers are separate Cordis providers. They share one machine-owned helper and use bounded, authenticated RPC. Remote paths are never rewritten into Host-local paths.

## Known Limitations and Deferred Work

The Profile and provider rows require Host composition wiring. A deployment must install the helper and its `.machine.json` manifest on the execution machine and configure an OpenSSH alias with strict host-key checking.
