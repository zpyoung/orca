import { describe, expect, it } from 'vitest'
import { createTickTrace } from '../fork-heimdall/tick-trace'
import {
  DEBUG_REPORT_LEDGER_ENTRY_LIMIT,
  DEBUG_REPORT_TRACE_LIMIT,
  buildHostedReviewSitterDebugReport,
  collapseHomeDirectory,
  type HostedReviewSitterDebugReportInput
} from './debug-report'
import { hostedReviewContentIdentity } from './action-identity'
import { describeHostedReviewSnapshot } from './kind-knowledge'
import type { HostedReviewSitterDefinition, HostedReviewSnapshot } from './types'

const HOME = '/Users/someone'
const REVIEW_URL = 'https://github.com/acme/repo/pull/42'

function definition(
  overrides: Partial<HostedReviewSitterDefinition> = {}
): HostedReviewSitterDefinition {
  return {
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    repoPath: `${HOME}/code/orca`,
    branch: 'feature/debug-report',
    provider: 'github',
    reviewNumber: 42,
    reviewUrl: REVIEW_URL,
    capabilities: { updateBranch: 'on', resolveConflicts: 'on', fixChecks: 'on', merge: 'gated' },
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    ...overrides
  }
}

function review(): HostedReviewSnapshot {
  return {
    provider: 'github',
    reviewNumber: 42,
    url: REVIEW_URL,
    lifecycle: 'open',
    headSha: 'head',
    baseSha: 'base',
    draft: false,
    behindBase: false,
    conflicts: 'none',
    checksComplete: true,
    providerReadiness: { verdict: 'ready', blockers: [] },
    queue: { required: false, membership: 'not-enqueued' },
    defaultMergeMethod: 'squash',
    checks: [
      {
        checkKey: 'build',
        checkId: 'build-1',
        name: 'build',
        required: true,
        state: 'passed',
        headSha: 'head',
        observationId: 'build:1',
        failureSignature: null
      }
    ]
  }
}

function input(
  overrides: Partial<HostedReviewSitterDebugReportInput> = {}
): HostedReviewSitterDebugReportInput {
  return {
    definition: definition(),
    status: null,
    budgetPolicy: { wallClockActiveMs: 60_000, turns: 10 },
    ledger: { watcherId: 'sitter-1', entries: [] },
    traces: [],
    runner: null,
    generatedAtMs: 1_700_000_000_000,
    appVersion: '1.4.200',
    platform: 'darwin',
    homeDirectory: HOME,
    ...overrides
  }
}

function observation(atMs: number) {
  return {
    kind: 'client-observation' as const,
    class: 'observation' as const,
    origin: 'client' as const,
    watcherId: 'sitter-1',
    eventId: `e${atMs}`,
    atMs,
    what: `observation-${atMs}`
  }
}

describe('PR sitter debug report', () => {
  it('builds a valid report for a stopped watcher with no runner', () => {
    const report = buildHostedReviewSitterDebugReport(input())
    expect(report.runner).toBeNull()
    expect(report.traces).toEqual([])
    expect(report.schemaVersion).toBe(2)
    expect(report.budget).toEqual({
      activeMs: 0,
      turns: 0,
      exhausted: null,
      policy: { wallClockActiveMs: 60_000, turns: 10 }
    })
  })

  it('caps the ledger but reports the true total', () => {
    const entries = Array.from({ length: DEBUG_REPORT_LEDGER_ENTRY_LIMIT + 50 }, (_unused, index) =>
      observation(index + 1)
    )
    const report = buildHostedReviewSitterDebugReport(
      input({ ledger: { watcherId: 'sitter-1', entries } })
    )
    expect(report.ledger.totalEntries).toBe(DEBUG_REPORT_LEDGER_ENTRY_LIMIT + 50)
    expect(report.ledger.entries).toHaveLength(DEBUG_REPORT_LEDGER_ENTRY_LIMIT)
    expect(report.ledger.entries.at(-1)?.atMs).toBe(DEBUG_REPORT_LEDGER_ENTRY_LIMIT + 50)
  })

  it('derives active wall-clock budget from kernel intervals', () => {
    const report = buildHostedReviewSitterDebugReport(
      input({
        ledger: {
          watcherId: 'sitter-1',
          entries: [
            {
              kind: 'interval-open',
              class: 'fact',
              origin: 'owner',
              watcherId: 'sitter-1',
              eventId: 'open-1',
              intervalId: 'interval-1',
              atMs: 1_000,
              cause: 'action-in-flight'
            },
            {
              kind: 'interval-close',
              class: 'fact',
              origin: 'owner',
              watcherId: 'sitter-1',
              eventId: 'close-1',
              intervalId: 'interval-1',
              atMs: 3_500,
              closeReason: 'settled'
            }
          ]
        }
      })
    )
    expect(report.budget.activeMs).toBe(2_500)
  })

  it('collapses a home directory instead of blanking the repo path', () => {
    const report = buildHostedReviewSitterDebugReport(input())
    expect(report.definition.repoPath).toBe('~/code/orca')
    expect(report.definition.branch).toBe('feature/debug-report')
    expect(report.definition.reviewUrl).toBe(REVIEW_URL)
  })

  it('leaves a path alone when it is outside the home directory', () => {
    expect(collapseHomeDirectory('/opt/repos/orca', HOME)).toBe('/opt/repos/orca')
    expect(collapseHomeDirectory(`${HOME}-other/x`, HOME)).toBe(`${HOME}-other/x`)
    expect(collapseHomeDirectory(HOME, HOME)).toBe('~')
  })

  it('redacts secrets in trace errors', () => {
    const failing = createTickTrace(1, 1_000, {
      consecutiveErrors: 1,
      lastFullResyncAtMs: null,
      reconcileAgain: false
    })
    failing.error = { message: 'auth failed: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' }
    const report = buildHostedReviewSitterDebugReport(input({ traces: [failing] }))
    expect(report.traces[0]?.error?.message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz')
  })

  it('keeps only the newest five traces with hosted-review snapshot details', () => {
    const reviewSnapshot = review()
    const traces = Array.from({ length: 8 }, (_unused, index) => {
      const entry = createTickTrace(index + 1, (index + 1) * 1_000, {
        consecutiveErrors: 0,
        lastFullResyncAtMs: null,
        reconcileAgain: false
      })
      const worldSnapshot = {
        freshness: 'live' as const,
        contentIdentity: hostedReviewContentIdentity(reviewSnapshot),
        observedAtMs: index + 1,
        world: { review: reviewSnapshot, definition: definition(), preparedCommit: null }
      }
      entry.snapshot = describeHostedReviewSnapshot(worldSnapshot)
      entry.contentIdentity = worldSnapshot.contentIdentity
      return entry
    })

    const report = buildHostedReviewSitterDebugReport(input({ traces }))
    expect(report.traces).toHaveLength(DEBUG_REPORT_TRACE_LIMIT)
    expect(report.traces[0]?.seq).toBe(8)
    expect(report.traces.at(-1)?.seq).toBe(4)
    expect(report.traces[0]?.snapshot?.checks).toHaveLength(1)
  })
})
