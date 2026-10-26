# Agent Note: The no-top-level-await gate

Status: implemented

English | [中文](2026-10-26-no-top-level-await-gate.zh.md)

## Problem

A module-scope `await` makes module evaluation asynchronous: every importer's evaluation waits on it, a rejection surfaces as a module-evaluation failure instead of an error the module handles, and the module cannot be lowered to the synchronous CommonJS wrapper bundlers load. The wave-5 survey recorded official's `verify-no-top-level-await` AST gate (row 11) as a cheap-hygiene absorb candidate; the entry-failure semantics apply to our package sources even without a WebWorker image.

## Decision

Port the gate as `scripts/verify-no-top-level-await.ts` (owner decision 2026-10-26) and wire it into `ci-shared-static-gates` (so every CI static and primary aggregate runs it), `check-all`, and the `hygiene` script aggregate.

The gate scans every `packages/*/*/src/**/*.{ts,tsx}` file with the TypeScript parser and reports `await` expressions, `for await` loops, and `await using` declarations whose nearest enclosing function body is the module itself — including those nested in top-level blocks, conditionals, loops, computed member names, and parameter defaults that run at module scope. Strings, templates, and comments are never code. Executables are excluded by declaration, never by file name: a `#!` first line, and the source of a `lib/<path>.js` target a package manifest's `bin` field names. The corpus proves its own coverage: it refuses an empty corpus, a corpus without TSX, and a glob that leaves out a package source directory, so the gate cannot pass by scanning less than it claims.

Porting the gate found one real violation: `packages/ssh/ssh/src/helper-entry.ts` awaited `runSshHelper()` at module scope — a public `./helper` export and a plain-Node process entry in one file. The entry now runs through an explicit `main()` whose floating promise keeps the same signal registration, error report, `exitCode`, and cleanup order; module evaluation is synchronous again and the file's behavior is unchanged (its suite passes).

## Alternatives considered

**A lint rule instead of a script.** No installed linter rule covers `await using` and computed-name positions with module-scope precision; the AST walk is small and owns its corpus guarantees.

**Waiting for the next defect.** The failure mode is a load-time crash class, not a code-review-visible one; the gate costs one parse over sources CI already type-parses.

## Consequences

- Every new package source is covered automatically: the corpus guard fails when a package with TypeScript sources is missed.
- Verification: 17 spec cases over detection shapes, exclusions, corpus refusal, and the shipped-tree scan (2001 files, 4 shebang executables excluded, no violation); the SSH helper suite (60 tests) passes after the entry fix.
