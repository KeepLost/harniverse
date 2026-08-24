# Agent Note: Python code runtime uses one hostile-peer process per run

Status: implemented

English | [中文](2026-08-25-python-code-runtime-provider.zh.md)

## Problem

The code-runtime Service Definition and Code Mode Consumer already describe Python, but the only executable Service Provider runs type-stripped TypeScript in a worker thread. The official Python package's fd-3 declarations do not execute a program. A usable Python backend must own the subprocess, bootstrap, binding bridge, output ledger, resource limits, cancellation, and teardown while preserving the same error-as-result and portable-binding contracts.

The child executes model-authored code and can write arbitrary bytes to every inherited descriptor. TypeScript types cannot make its frames trustworthy, and process isolation alone cannot make same-host Python a sandbox.

## Decision

`@deepseek-ai/dsh-code-runtime-python` is an opt-in Service Provider. `PythonCodeRuntime extends CodeRuntime`, reports `language: 'python'` and `isolation: 'process'`, and starts a fresh configured executable for every run with `shell: false`, an empty environment, and a package-owned standard-library bootstrap. No shipped Profile or bundle selects it; replacing the existing `code-runtime` Cordis row is a deployment decision, and the existing `dsh-tools` language dispatch supplies the Python SDK and `run_code` strings.

The bootstrap receives `boot` metadata on fd 3, applies `RLIMIT_CPU` and `RLIMIT_AS` where available, acknowledges readiness, and then receives a separate `run` frame. It wraps source in `async def __dsh_main__()` for top-level `await` and `return`, materializes namespaces and typed binding exceptions from metadata, and validates every binding argument, reply, and completion as lossless JSON. Python-level stdout, stderr, and console-style writes share the ordered control stream; the Host retains stdout/stderr pipes as bounded backstops for native writes.

The Host caps each JSONL line before parsing, rejects integer tokens that `JSON.parse` would round, validates and rebuilds recognized child frames field by field, ignores malformed/unknown frames and duplicate call ids, and performs own-property binding lookup. One settlement owner handles done, process error/exit, CPU signal, wall timeout, abort, output overflow, and disposal. It kills the child and awaits `close` before resolving a run or completing teardown. Program and process outcomes resolve in `CodeRunResult.error`; only invalid config, invalid portable bindings, and calls after disposal reject.

Failure text from the process boundary is static or path-scrubbed and bounded. Host binding rejections become the typed program-side message `binding call failed`, rather than carrying an arbitrary Host exception that could contain a path or credential. The process receives no ambient environment, but it still shares the Host filesystem, network, working directory, and identity; the provider explicitly makes no sandbox claim.

The TypeScript and Python protocol declarations expose an executable field-roster mirror check. Real-subprocess tests cover successful code and logs, binding resolution and rejection, hostile/malformed frames, invalid output, CPU/wall timeout, abort, output bounds, fresh-run state, disposal quiescence, and the built package entry.

## Alternatives considered

**Treat the official protocol-only package as the backend.** Rejected because declarations and mirror tests do not own process execution, cancellation, output, or quiescence; mounting that package cannot satisfy `CodeRuntime.run()`.

**Run Python through a shell command or the existing shell tool.** Rejected because shell interpolation adds an injection boundary, makes fd ownership and cancellation indirect, and moves provider lifecycle into a Consumer. Direct `spawn()` keeps executable selection and process settlement inside the Service Provider.

**Make Python the shipped default.** Rejected because existing Profiles intentionally select the worker-thread provider and Code Mode composition is independently opt-in. A new backend must not silently change source language or shipped model instructions.

**Claim the subprocess is a security sandbox.** Rejected because a same-user process can access the same host resources despite resource limits and an empty environment. A hard boundary belongs to a container or sandbox provider.

## Consequences

Deployments can compose real Python Code Mode without changing the model-facing tool or the agent loop. Every run pays CPython startup cost and has no persistent kernel state. CPython 3.10 is the minimum supported interpreter, matching the existing Python SDK syntax.

Resource enforcement varies by operating system: the Host wall timer, process kill, frame cap, and output ledger remain universal, while `resource` limits apply only where exposed. Python cannot distinguish explicit `return None` from falling off the wrapper function, so both return JSON `null`. Native fd 1 and fd 2 writes remain bounded but have only operating-system event order across separate pipes. The provider accepts the Python SDK renderer's Node/CPython Unicode-table skew for non-ASCII tool-derived identifiers at the 3.10 floor; ASCII names are unaffected and indexed namespace access remains available.
