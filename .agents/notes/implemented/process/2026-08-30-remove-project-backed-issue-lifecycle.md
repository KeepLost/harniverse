# Agent Note: Keep PR policy independent of Projects

Status: implemented

English | [中文](2026-08-30-remove-project-backed-issue-lifecycle.zh.md)

## Problem

Project-backed Issue lifecycle automation requires a durable Project owner and a credential that can read and mutate that Project. Harniverse's repository is user-owned, while the available GitHub App installation token cannot access a user-owned Projects v2 board. Keeping the integration active would turn every Issue event into a predictable failed workflow.

## Decision

Harniverse keeps the read-only pull-request policy and removes the Project-backed Issue lifecycle. The policy requires a human non-Draft pull request that has entered review to reference at least one same-repository Issue, use exactly one supported `kind/*` label, use at least one `area/*` label, and avoid retired or Issue-only labels. Bot, App, and Draft pull requests remain exempt.

The policy resolves referenced Issues through the repository REST API and uses `GITHUB_REPOSITORY` as its repository identity. It does not query ProjectV2, read Issue field values, mutate Project items, or write Issue audit comments. The Issue lifecycle workflow, Project configuration, Project Status and Priority rules, and review-driven status transitions are not part of the shipped automation.

The repository keeps the policy test in its static CI gates. The pull-request template documents Issue references but does not require a Project Priority. No GitHub App credential is required by the remaining policy workflow.

## Alternatives considered

**Keep the user-owned Project with a GitHub App.** Rejected because GitHub App installation tokens cannot access user-owned Projects v2, so the workflow cannot implement the required Project mutations.

**Store a maintainer user token in Actions.** Rejected because a user token would couple automation to a personal identity and expose account-scoped Project and repository permissions to trusted workflow code.

**Remove all Issue and pull-request policy.** Rejected because same-repository references and PR label taxonomy remain useful independent constraints.

**Leave the lifecycle workflow active after removing the Project.** Rejected because Issue events would continue producing failures instead of a deliberate no-op.

## Consequences

Issue creation, editing, closing, reopening, assignment, labels, and PR review events no longer update a Project or create lifecycle audit comments. Issues remain native GitHub records, and their lifecycle is maintained through GitHub's own state, labels, assignees, and comments.

Pull requests still receive the repository's metadata and Issue-reference policy after a human PR enters review. The policy uses only repository read access, so the lifecycle App client ID, private key, installation, and user-owned Project can be removed without weakening the remaining check.

The removed lifecycle can be reintroduced if Harniverse adopts an automation-compatible Project owner and credential boundary, such as an organization-owned Project operated by a narrowly installed GitHub App.
