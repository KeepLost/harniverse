#!/usr/bin/env node

import fs from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const API_VERSION = '2026-03-10'
const PR_KINDS = new Set([
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
])
// Retired label aliases stay reserved so they cannot be recreated.
const LEGACY_LABELS = new Set([
  'kind/bug',
  'kind/documentation',
  'feature',
  'bug-fix',
  'doc',
  'cleanup',
  'testing',
  'dependencies',
  'ci',
  'cli',
  'llm',
  'web-search',
])
/**
 * Decide whether the human-review policy applies to a PR.
 * @param {{isDraft: boolean, authorType: string, reviewRequestCount: number, reviewCount: number}} input PR state.
 * @returns {boolean} Whether the PR policy is mandatory.
 */
export function requiresPullRequestPolicy({
  isDraft,
  authorType,
  reviewRequestCount,
  reviewCount,
}) {
  const automated = authorType === 'Bot' || authorType === 'App'
  return !isDraft && !automated && (reviewRequestCount > 0 || reviewCount > 0)
}

function stripIgnoredMarkdown(body) {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  const kept = []
  let fence = null
  for (const line of lines) {
    const marker = line.match(/^\s*([\u0060~]{3,})/)
    if (marker) {
      if (fence === null) fence = marker[1][0]
      else if (marker[1][0] === fence) fence = null
      continue
    }
    if (fence === null) kept.push(line)
  }
  return kept.join('\n').replace(/\u0060[^\u0060]*\u0060/g, ' ')
}

/**
 * Parse same-repository resolving and informational references.
 * @param {{body: string, repository: string}} input PR body and repository.
 * @returns {{all: number[], resolving: number[], related: number[]}} References.
 */
export function parseReferences({ body, repository }) {
  const source = stripIgnoredMarkdown(body)
  const expected = repository.toLowerCase()
  const all = new Set()
  const resolving = new Set()
  const reference =
    /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|#)(\d+)|https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)/gi
  const closing =
    /\b(?:close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?)\s*:?\s+(?:(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#|#)(\d+)|https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+))/gi

  for (const match of source.matchAll(reference)) {
    const explicit = (match[1] ?? match[3] ?? '').toLowerCase()
    const number = Number(match[2] ?? match[4])
    if (!explicit || explicit === expected) all.add(number)
  }
  for (const match of source.matchAll(closing)) {
    const explicit = (match[1] ?? match[3] ?? '').toLowerCase()
    const number = Number(match[2] ?? match[4])
    if (!explicit || explicit === expected) {
      all.add(number)
      resolving.add(number)
    }
  }
  return {
    all: [...all].sort((left, right) => left - right),
    resolving: [...resolving].sort((left, right) => left - right),
    related: [...all].filter((number) => !resolving.has(number)).sort((a, b) => a - b),
  }
}

/**
 * Retain only references that resolve to Issues rather than pull requests.
 * @param {{all: number[], resolving: number[], related: number[]}} references Parsed references.
 * @param {Map<number, unknown>} issues Resolved same-repository Issues.
 * @returns {{all: number[], resolving: number[], related: number[]}} Issue-only references.
 */
export function retainIssueReferences(references, issues) {
  return {
    all: references.all.filter((number) => issues.has(number)),
    resolving: references.resolving.filter((number) => issues.has(number)),
    related: references.related.filter((number) => issues.has(number)),
  }
}

/**
 * Validate PR metadata and its referenced Issues.
 * @param {{authorType: string, labels: string[], references: ReturnType<typeof parseReferences>, issues: Map<number, unknown>}} input PR snapshot.
 * @returns {string[]} Validation errors.
 */
export function validatePullRequest(input) {
  if (!requiresPullRequestPolicy(input)) return []
  const errors = []
  const kinds = input.labels.filter((label) => PR_KINDS.has(label))
  const unknownKinds = input.labels.filter(
    (label) => label.startsWith('kind/') && !PR_KINDS.has(label) && !LEGACY_LABELS.has(label),
  )
  const legacyLabels = input.labels.filter((label) => LEGACY_LABELS.has(label))
  const sourceLabels = input.labels.filter((label) => label.startsWith('source/'))
  const areas = input.labels.filter((label) => label.startsWith('area/'))

  if (input.references.all.length === 0) errors.push('PR 正文必须引用至少一个同仓库 Issue')
  if (kinds.length !== 1) {
    errors.push(`PR 必须恰好有一个允许的 kind/*，当前为 ${kinds.length}`)
  }
  if (unknownKinds.length > 0) {
    errors.push(`PR 含不支持的 kind/*：${unknownKinds.join(', ')}`)
  }
  if (legacyLabels.length > 0) errors.push(`PR 含旧版标签：${legacyLabels.join(', ')}`)
  if (sourceLabels.length > 0) errors.push(`source/* 仅用于 Issue：${sourceLabels.join(', ')}`)
  if (areas.length === 0) errors.push('PR 必须至少有一个 area/*')
  for (const number of input.references.all) {
    if (!input.issues.has(number)) errors.push(`#${number} 不是同仓库 Issue`)
  }
  return errors
}

function token() {
  const value = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!value) throw new Error('GH_TOKEN 或 GITHUB_TOKEN 未设置')
  return value
}

async function api(path, options = {}) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token()}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'dsh-issue-policy',
      ...options.headers,
    },
  })
  if (options.allow404 && response.status === 404) return null
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status} ${body}`)
  }
  if (response.status === 204) return null
  return response.json()
}

function repositoryName() {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('GITHUB_REPOSITORY 未设置')
  return repository
}

async function resolvingReferencesSnapshot(pull, repository) {
  const references = parseReferences({
    body: pull.body ?? '',
    repository,
  })
  const issues = new Map()
  for (const issueNumber of references.all) {
    const issue = await api(`/repos/${repository}/issues/${issueNumber}`)
    if (!issue.pull_request) issues.set(issueNumber, issue)
  }
  return {
    references: retainIssueReferences(references, issues),
    issues,
  }
}

async function pullRequestSnapshot(number, repository) {
  const [pull, reviewRequests, reviews] = await Promise.all([
    api(`/repos/${repository}/pulls/${number}`),
    api(`/repos/${repository}/pulls/${number}/requested_reviewers`),
    api(`/repos/${repository}/pulls/${number}/reviews?per_page=100`),
  ])
  const snapshot = {
    isDraft: pull.draft,
    authorType: pull.user?.type ?? 'User',
    reviewRequestCount: reviewRequests.users.length + reviewRequests.teams.length,
    reviewCount: reviews.length,
    labels: pull.labels.map((label) => label.name),
  }
  if (!requiresPullRequestPolicy(snapshot)) {
    return {
      ...snapshot,
      references: { all: [], resolving: [], related: [] },
      issues: new Map(),
    }
  }
  const resolving = await resolvingReferencesSnapshot(pull, repository)
  return {
    ...resolving,
    ...snapshot,
  }
}

async function runPullRequestCheck(event) {
  const pull = await pullRequestSnapshot(event.pull_request.number, repositoryName())
  const errors = validatePullRequest(pull)
  if (errors.length > 0) {
    for (const error of errors) process.stdout.write(`::error::${error}\n`)
    throw new Error(`Issue policy 未通过，共 ${errors.length} 项`)
  }
  process.stdout.write(
    requiresPullRequestPolicy(pull) ? 'Issue policy 通过。\n' : 'PR 尚未进入 Issue policy 强制范围。\n',
  )
}

function readEvent() {
  if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH 未设置')
  return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
}

async function main(argv) {
  const [command] = argv
  if (command === 'pr') await runPullRequestCheck(readEvent())
  else throw new Error('用法：policy.mjs pr')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
