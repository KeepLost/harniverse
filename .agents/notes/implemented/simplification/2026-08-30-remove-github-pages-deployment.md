# Agent Note: Keep GitHub Pages out of Harniverse deployment

Status: implemented

English | [中文](2026-08-30-remove-github-pages-deployment.zh.md)

## Problem

Harniverse has a canonical documentation projector and a VitePress build, but this repository is not using GitHub Pages as a product deployment target. The Pages workflow required repository hosting configuration that is intentionally absent and produced a failing post-merge run without adding value to the development feedback loop.

## Decision

The GitHub Pages deployment workflow `.github/workflows/docs-pages.yml` is removed, and the corresponding GitHub Actions workflow is disabled. Documentation construction remains supported: `website/docs.ts` projects canonical sources, `pnpm run doc-sync` validates documentation, and the website build continues to produce the disposable `website/.dist` output for local and CI checks.

The repository does not configure the `github-pages` environment, Pages hosting, Pages deployment permissions, or a public documentation URL. Future hosting can consume the existing website build through a separately reviewed deployment decision.

## Alternatives considered

**Enable GitHub Pages and create the missing hosting environment.** Rejected because hosted documentation is not a current product requirement, and its configuration would add an external deployment surface to a development-stage repository.

**Keep the workflow active while Pages remains unconfigured.** Rejected because every `master` push would report a predictable configuration failure that does not validate Harniverse code or documentation construction.

**Remove the website projector and VitePress build as well.** Rejected because local and CI documentation validation remains useful and is independent of the hosting provider.

## Consequences

Documentation changes continue to receive build and link validation without attempting a hosted deployment. GitHub Actions no longer needs Pages or deployment-token permissions for this repository, and a future hosting provider can be selected without changing canonical documentation ownership or public route projection.
