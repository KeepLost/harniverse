# Agent Note: User-owned Project for Harniverse Issue Automation

Status: implemented
Archived: 2026-08-30

English | [中文](2026-08-30-user-owned-project-issue-automation.zh.md)

## Problem

The Issue policy and lifecycle workflows execute in Harniverse, but their repository and Project configuration targeted the upstream `deepseek-harness/deepseek-harness` repository and its organization-owned Project. Harniverse is `KeepLost/harniverse`, and `KeepLost` is a GitHub user rather than an organization, so the old GraphQL owner lookup and REST paths could not operate on the downstream repository.

The lifecycle workflow also needs a credential that can mutate Issue comments and a user-owned Project without exposing a maintainer's personal token to workflow code.

## Decision

Harniverse uses the user-owned Project [Harniverse Issue Management](https://github.com/users/KeepLost/projects/1) as the lifecycle projection. [Issue-management configuration](../../../../.github/issue-management/config.json) names `KeepLost/harniverse` as the repository, declares `KeepLost` as the Project owner, and records `projectOwnerType: "user"`. The Project Status field contains exactly `Inbox`, `Backlog`, `Ready`, `In progress`, `In review`, `Done`, and `No action`; the Project also contains the configured `Priority` field with `P0` through `P3` options.

[Policy implementation](../../../../.github/issue-management/policy.mjs) uses the repository owner for REST requests and selects the `user(login:)` or `organization(login:)` GraphQL Project owner from configuration. This keeps the Project lookup explicit while retaining support for an organization-owned installation if a future deployment changes that configuration.

[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) creates an installation token scoped to the `KeepLost` account and only the `harniverse` repository. The workflow reads the App client ID from `HARNIVERSE_ISSUE_APP_CLIENT_ID` and the private key from `HARNIVERSE_ISSUE_APP_PRIVATE_KEY`; no personal access token is stored in the repository. The installed App needs read access to repository contents and pull requests, read/write access to Issues, metadata read access, and Projects read/write access for the Project API mutations.

Pull-request policy checks determine Bot, App, and Draft exemptions before resolving references from the pull-request body. Dependency release notes can therefore contain unrelated upstream `#123` references without causing Harniverse Issue lookups or false policy failures.

## Alternatives considered

**Keep the upstream organization and repository configuration.** Rejected because Harniverse workflows would continue requesting resources that do not exist in the downstream repository, and lifecycle mutations could target the wrong product.

**Use a repository-owned Project.** Rejected because `KeepLost` is a user account and the requested lifecycle board is intentionally user-owned; the implementation still supports organization-owned Projects through the explicit owner-type setting.

**Use the default `GITHUB_TOKEN` for Project and Issue mutations.** Rejected because the workflow token does not provide the required user-owned Project API capability and its repository-scoped identity is not an appropriate substitute for a narrowly installed automation identity.

**Store a maintainer personal access token in repository secrets.** Rejected because a GitHub App provides short-lived installation tokens, explicit repository selection, and revocable permissions without coupling automation to a personal credential.

## Consequences

Issue and pull-request events in `KeepLost/harniverse` can project lifecycle state into the user-owned Project after the App is created and installed with the declared permissions. The Project remains outside repository ownership, so its access and visibility are governed by the `KeepLost` account and must be kept aligned with the repository's operational needs.

The workflow fails explicitly until the App client ID variable, private-key secret, App installation, and Projects permission are configured. This is preferable to silently skipping lifecycle updates or falling back to a personal token. The policy workflow remains read-only, while lifecycle retains its existing audit-comment behavior; neither workflow gains permission to merge, push, publish, or administer the repository.
