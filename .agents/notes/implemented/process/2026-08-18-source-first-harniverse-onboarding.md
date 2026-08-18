# Agent Note: Source-first Harniverse onboarding

Status: implemented

English | [中文](2026-08-18-source-first-harniverse-onboarding.zh.md)

## Problem

The repository root identified its checkout as the official DeepSeek Harness product and led with an npm command that installs the upstream package. A Harniverse reader could therefore run a different distribution, clone a different repository, or reach a running Web server without knowing that the first browser still needs an owner Grant and a configured model before it can complete a task.

## Decision

The root README identifies Harniverse as a source-first DeepSeek Harness downstream and owns one executable path from prerequisites through the first assistant response. The path verifies Git, Node.js, and pnpm; clones `KeepLost/harniverse`; installs and builds the checkout; starts `pnpm dsh web`; approves the first browser from a second terminal using the same `DSH_HOME`; configures and selects a model; selects a workspace; and sends one verification prompt.

The README explicitly distinguishes `pnpm dsh` in this checkout from `npx @deepseek-ai/dsh`, which resolves the official npm package. It treats a printed Web URL as an intermediate state rather than successful onboarding: a fresh home has no approved browser, no configured model route, and no selected workspace. Expected observations and focused troubleshooting stay beside the step that needs them.

The published Web guide owns expanded enrollment and remote-serving instructions. The model guide owns provider-specific credentials, endpoints, and modality configuration. The root remains self-contained for first use but links those descendants rather than duplicating their advanced cases. Package and capability inventories remain in their owning references, with [PLUGINS.md](../../../../PLUGINS.md) as the downstream baseline and composition authority.

Both README languages use the same technical structure. Harniverse support links point to the Harniverse repository, and the architecture entry plus documentation-site title, repository link, and edit links identify the downstream project. Upstream DeepSeek Harness, inherited package names, Cordis, and licensing links remain explicit attribution rather than being relabeled as downstream resources.

This decision supersedes the archived [product-first root README](../../archived/process/2026-07-22-product-first-root-readme.md) structure. Its durable constraints survive here: the root remains a product entry rather than a package catalog, exhaustive inventories stay elsewhere, bilingual sides remain structurally aligned, and the page avoids screenshots or a second marketing narrative that can drift from executable commands.

## Alternatives considered

**Keep the upstream README shape and change only names and URLs.** This would minimize the diff, but it would still stop at server startup and omit the owner-enrollment, model, and workspace prerequisites that determine whether Harniverse can answer a request.

**Put the complete first-run path only in the documentation website.** A single tutorial owner reduces repetition, but repository visitors encounter the root README first. Requiring another navigation hop before disclosing that the npm command installs a different product is an unsafe entry path.

**Publish a one-command Harniverse package before changing the docs.** A dedicated package would simplify installation, but no downstream package name, release tags, compatibility policy, or publication channel exists. Documentation cannot claim a distribution that has not shipped.

**Replace every upstream DeepSeek Harness name and link.** This would erase intentional provenance and misstate inherited package identities. Only links whose purpose is obtaining, supporting, or editing Harniverse move to the downstream repository.

## Consequences

A new reader can validate each stage and distinguish installation, server startup, device admission, model readiness, workspace readiness, and first successful inference. The root README becomes longer and repeats the minimum first-run sequence from the Web guide, but each copy has a distinct entry context and links advanced detail to one owner.

Until Harniverse publishes its own distribution, source setup remains more expensive than `npx`: users retain a checkout and rebuild after updates. Future release work must replace this path only when a real package or artifact exists and must update the bilingual README, Web guide, and distribution metadata together.
