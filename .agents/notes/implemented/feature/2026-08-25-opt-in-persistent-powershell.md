# Agent Note: Opt-in persistent PowerShell

Status: implemented

English | [中文](2026-08-25-opt-in-persistent-powershell.zh.md)

## Problem

The shipped `dsh-tool-pwsh` starts a fresh process for each call, so PowerShell cwd, environment, variables, functions, and jobs cannot survive a model turn. Reusing the persistent Bash wrapper would corrupt PowerShell input through Bash quoting and prompt setup. Windows PTY teardown also cannot rely on POSIX groups, numeric PIDs, or node-pty exit events.

## Decision

`@deepseek-ai/dsh-tool-pwsh-persistent` is a separate function plugin over `ctx.terminals`. It registers the same model-facing `pwsh(command)` name as the one-shot tool, keeps one PTY per exact Agent, and serializes calls for that owner. Deployments must choose one `pwsh` Consumer; Agent Profile composition records both package names as owners of `pwsh` so a selected conflict is rejected.

The package uses PowerShell-native bootstrap and command wrappers. A PowerShell `prompt` function emits the terminal readiness marker; commands use backtick escaping, randomized start/end markers, `Invoke-Expression`, `$?`, and `$LASTEXITCODE`. Timeout, cancellation, initialization failure, send failure, and shell exit close the owner session before another call can reuse uncertain state. Output clipping follows the persistent shell convention, while fixed reset and status diagnostics may extend the configured command-output bound.

The local subprocess provider adds a Windows inspector behind an injectable module boundary. Koffi 3.1 resolves Toolhelp32 and `GetProcessTimes` from `kernel32.dll`; process identities are `{ pid, started }`, and liveness plus every targeted termination rechecks the exact creation time. Tree walks are children-first, cycle-safe, and omit unreadable or disappeared members. Ctrl-C is a terminal input write; TERM and KILL use taskkill trees. Root identity mismatch stops descendant adoption, and verified root absence settles a node-pty exit event that never arrived.

Koffi already resolves to 3.1.1 elsewhere in the workspace, so subprocess-local declares the maintained `^3.1.0` range without adding another lockfile version. The existing node-pty `^1.1.0` API supports the implementation and remains unchanged.

The CLI distribution includes the plugin for explicit composition, and the ACP and package Loader fixtures mount it beside a PowerShell-dialect `dsh-terminal-bash`. No base bundle, shipped Profile, or preset mounts it; the shipped one-shot `dsh-tool-pwsh` default remains unchanged.

## Alternatives considered

**Replace the shipped one-shot pwsh row.** Rejected because persistent mutable state changes execution, timeout, cancellation, and cleanup semantics. Deployments opt in explicitly.

**Adapt the persistent Bash wrapper.** Rejected because `PS1`, `PROMPT_COMMAND`, `stty`, Bash ANSI-C quoting, and `$?` do not implement PowerShell input or status semantics.

**Trust the numeric PID or taskkill without an identity fence.** Rejected because PID reuse could transfer teardown ownership to an unrelated process tree.

**Write a project-owned native addon or upgrade node-pty.** Rejected because maintained koffi bindings provide the required Win32 calls, while the current node-pty API already provides all terminal operations this layer needs.

## Consequences

Persistent PowerShell state is available without changing shipped defaults. The plugin has the same tool name as one-shot pwsh by design, so a composition must select exactly one. Native bridge failures surface when Windows process inspection first resolves `kernel32.dll`; non-Windows imports never load that library. Mocked tests provide deterministic cross-host logic coverage, but native Windows CI must exercise real ConPTY, Koffi ABI layout, Ctrl-C delivery, taskkill escalation, process disappearance races, and missing node-pty exit events before Harniverse claims Windows platform validation.
