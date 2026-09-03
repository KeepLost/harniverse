# Agent Note: Native macOS shell and Intel runtime coverage

Status: implemented

English | [中文](2026-09-03-macos-native-shell-and-intel-runtime.zh.md)

## Problem

macOS users received a POSIX execution surface, but the local one-shot and persistent shell paths were Bash-shaped even though macOS ships zsh as its default shell. Runtime-wheel publication also covered Apple Silicon without a native Intel macOS artifact, leaving a supported host architecture outside the release matrix.

## Decision

The shell capability owns platform defaults. One-shot local and sandboxed execution uses `/bin/zsh -c` on macOS and `bash -c` elsewhere. The persistent terminal backend uses `/bin/zsh -f -i` on macOS and `/bin/bash --noprofile --norc -i` elsewhere. Bash keeps its `PROMPT_COMMAND` marker; zsh carries the equivalent private OSC marker in `PS1`, so readiness semantics remain unchanged. Explicit shell configuration still wins.

The runtime manifest owns both `macos-arm64` and `macos-x64` wheel tags and executable names. Native GitHub and GitLab release jobs can build and validate both macOS targets, including each executable's `node-pty` spawn helper and its Mach-O deployment target; no release is run by this change. Pull-request CI runs the native macOS unit suite and real Seatbelt tests as an independent, non-blocking signal rather than an `all-checks-passed` dependency.

## Alternatives considered

**Keep Bash as the macOS default.** Rejected because it contradicts the host's standard shell and makes direct shell execution differ from the platform default.

**Use one macOS runtime artifact for both architectures.** Rejected because the executable and native `node-pty` helper are architecture-specific.

**Leave Seatbelt validation on master-only CI.** Rejected because shell and sandbox regressions benefit from a pull-request signal even when the macOS runner is not part of the merge-blocking verdict.

## Consequences

Linux and Windows shell behavior remains unchanged. macOS shell output and prompt readiness use the same capability contracts with a zsh-specific marker implementation. Complete manual Python release validation can produce one SDK wheel and four native runtime wheels, while selected-target builds retain only the requested runtime wheels; this change does not publish them. The local Linux environment cannot execute the macOS shell, Seatbelt, or Intel build paths; native macOS CI remains the authoritative verification for those paths.

## Verification

Relevant shell and workflow tests pass locally; Python deployment-target tests pass; typecheck, build, YAML parsing, and documentation gates pass. The full unit suite retains existing permission-fixture failures when run as root, so those tests require a non-root environment or the native CI runners for final confirmation.
