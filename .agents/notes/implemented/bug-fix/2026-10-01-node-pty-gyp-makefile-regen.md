# Agent Note: node-pty builds never regenerate the gyp Makefile

Status: implemented

English | [中文](2026-10-01-node-pty-gyp-makefile-regen.zh.md)

## Problem

The Linux performance lanes build `node-pty` from source at install time (upstream ships no Linux prebuilds). node-gyp's make generator emits a `Makefile` whose self-regeneration recipe executes `gyp_main.py` directly by shebang; pnpm's bundled node-gyp ships that file mode 0644 (pnpm/pnpm#12455), so whenever make considered the freshly generated `Makefile` stale — a sub-second mtime race against `binding.gyp`/`config.gypi` written in the same tick — the regen died with `/bin/sh: gyp_main.py: Permission denied` and `make: *** [Makefile] Error 126`, failing `pnpm install` nondeterministically (job 110261333841; two earlier runs of the same lockfile passed).

## Decision

The existing `patches/node-pty@1.1.0.patch` also rewrites the install script from `node scripts/prebuild.js || node-gyp rebuild` to `node scripts/prebuild.js || (node-gyp configure && make -C build -o Makefile BUILDTYPE=Release)`. The regen rule's prerequisites are shared gyp inputs (`common.gypi` in the header cache, `addon.gypi` inside pnpm's dist, the sibling `node-addon-api` gyp files); a parallel native build such as `cpu-features` can touch any of them between our configure and our make, so no mtime pinning of the generated `Makefile` can decide the race — the first attempt (`touch build/Makefile`) still lost on CI exactly this way. `make --old-file Makefile` removes the decision from mtime comparison entirely: the Makefile is declared up to date, the regen recipe never runs, and the missing executable bit cannot matter. The branch only executes where no prebuilds exist (Linux); the Windows and macOS lanes keep their prebuild path.

## Alternatives considered

- **Bump pnpm** — rejected for now: the upstream issue is unresolved and no released pnpm ships the executable entrypoints.
- **Pin the generated Makefile's mtime after configure** — rejected: defeated by parallel builders touching the shared gyp inputs after the pin (observed on CI).
- **`chmod +x` the bundled `gyp_main.py` in CI** — rejected: patches the runner's toolchain per-workflow and leaves every other consumer (developers, other lanes) exposed to the same race.

## Consequences

Linux installs build node-pty deterministically without the regen recipe; the patch hash in `pnpm-lock.yaml` changed accordingly. Verified by reproducing the race locally (fresh `node-gyp configure`, `touch common.gypi`, plain `make` regenerates and dies with Error 126, `make -o Makefile` builds cleanly), a fresh local install through the patched line, and a functional pty spawn round-trip through `subprocess-local`.
