# acp/ — Agent Client Protocol

English | [中文](README.zh.md)

The ACP group speaks the Agent Client Protocol in both directions. None of it is a presentation or human-interaction layer.

| Package | Role |
|---|---|
| [`acp/`](acp/README.md) | Automation-only ACP server: exposes harness agents to programmatic clients. |
| [`acp-client/`](acp-client/README.md) | Version-neutral client core: process transport, handshake, sign-in on demand, sessions, turns, options, questions, and permission answers for any conforming agent. |
| [`agent-acp/`](agent-acp/README.md) | ACP mode: the step driver that runs a session on an external agent, with the preset template that names it. |

The out-of-process subagent client in [`subagent/subagent-acp`](../subagent/subagent-acp/README.md) is the client core's other consumer; it lives under `subagent/` because it implements the subagent provider interface.
