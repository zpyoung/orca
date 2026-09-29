import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hostedReviewAttemptFingerprint } from '../../shared/fork-hosted-review-sitter/action-identity'
import { explainDesiredAction } from '../../shared/fork-hosted-review-sitter/decision'
import { deriveHostedReviewSitterDiscrepancies } from '../../shared/fork-hosted-review-sitter/reconciliation'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewSitterDefinition,
  HostedReviewSnapshot
} from '../../shared/fork-hosted-review-sitter/types'
import { buildRerunAction } from '../../shared/fork-hosted-review-sitter/decision-action-builders'
import { failedCheckGroups } from '../../shared/fork-hosted-review-sitter/decision-check-groups'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ProjectRef } from '../gitlab/gl-utils'
import { normalizeChecks } from './provider-github-checks'
import {
  attachGitLabFailureSignatures,
  loadAllPipelineRows,
  loadExternalStatusChecks,
  normalizePipelineJobs
} from './provider-gitlab-checks'
import type { HostedReviewSitterGitExecution } from './provider-git'

const mocks = vi.hoisted(() => ({
  runGitLabApi: vi.fn(),
  getPRCheckDetails: vi.fn()
}))

vi.mock('../github/client', () => ({ getPRCheckDetails: mocks.getPRCheckDetails }))

vi.mock('./provider-gitlab-read', () => ({
  booleanValue: (value: unknown) => (typeof value === 'boolean' ? value : null),
  isNotFound: () => false,
  numberValue: (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null,
  runGitLabApi: mocks.runGitLabApi,
  stringValue: (value: unknown) => (typeof value === 'string' ? value : '')
}))

vi.mock('./provider-git', () => ({ throwIfAborted: vi.fn() }))

const HEAD = 'head-1'
const BASE = 'base-1'
const PROJECT_REF: ProjectRef = { host: 'gitlab.com', path: 'acme/widgets' }

function definition(
  provider: HostedReviewSitterDefinition['provider'],
  mergeCheckScope: 'required' | 'all' = 'all'
): HostedReviewSitterDefinition {
  return {
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    repoPath: '/repo',
    branch: 'feature',
    provider,
    reviewNumber: 42,
    reviewUrl: `https://${provider === 'github' ? 'github.com' : 'gitlab.com'}/acme/widgets/review/42`,
    capabilities: { updateBranch: 'on', resolveConflicts: 'on', fixChecks: 'on', merge: 'on' },
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    mergeCheckScope
  }
}

function review(
  provider: HostedReviewSnapshot['provider'],
  checks: readonly HostedReviewCheckSnapshot[]
): HostedReviewSnapshot {
  return {
    provider,
    reviewNumber: 42,
    url: `https://${provider === 'github' ? 'github.com' : 'gitlab.com'}/acme/widgets/review/42`,
    lifecycle: 'open',
    headSha: HEAD,
    baseSha: BASE,
    draft: false,
    checks,
    checksComplete: true,
    providerReadiness: { verdict: 'ready', blockers: [] },
    behindBase: false,
    conflicts: 'none',
    queue: { required: false, membership: 'not-enqueued' },
    defaultMergeMethod: 'squash'
  }
}

function emptyLedger(): WatcherLedger {
  return { watcherId: 'sitter-1', entries: [] }
}

// The reader tests reach only `runGitLabApi`; this partial double intentionally leaves all Git methods unused.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provider reader functions under test call only the mocked GitLab API.
const git = {} as unknown as HostedReviewSitterGitExecution

beforeEach(() => {
  vi.clearAllMocks()
})

describe('hosted review provider check readers', () => {
  it('keeps same-name GitHub check runs from separate workflow executions', () => {
    const normalized = normalizeChecks(
      [
        {
          __typename: 'CheckRun',
          databaseId: 101,
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          startedAt: '2026-04-01T00:00:00Z',
          completedAt: '2026-04-01T00:01:00Z',
          checkSuite: {
            databaseId: 11,
            app: { databaseId: 7 },
            workflowRun: { databaseId: 1001 }
          }
        },
        {
          __typename: 'CheckRun',
          databaseId: 202,
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          startedAt: '2026-04-01T00:02:00Z',
          completedAt: '2026-04-01T00:03:00Z',
          checkSuite: {
            databaseId: 22,
            app: { databaseId: 7 },
            workflowRun: { databaseId: 2002 }
          }
        }
      ],
      [],
      HEAD
    )

    expect(normalized.checks).toHaveLength(2)
    expect(normalized.checks.map((check) => check.checkId).sort()).toEqual([
      'workflow:1001:check:101',
      'workflow:2002:check:202'
    ])
    expect(normalized.checks.map((check) => check.state).sort()).toEqual(['failed', 'passed'])
  })
  it('keeps same-name GitHub check runs from distinct suites without workflow identity', () => {
    const normalized = normalizeChecks(
      [
        {
          __typename: 'CheckRun',
          databaseId: 303,
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          checkSuite: { databaseId: 33, app: { databaseId: 7 } }
        },
        {
          __typename: 'CheckRun',
          databaseId: 404,
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          checkSuite: { databaseId: 44, app: { databaseId: 7 } }
        }
      ],
      [],
      HEAD
    )

    expect(normalized.checks).toHaveLength(2)
    expect(normalized.checks.map((check) => check.checkId).sort()).toEqual([
      'check:303',
      'check:404'
    ])
  })

  it('escalates an all-scope optional GitHub StatusContext instead of repeating an impossible rerun', () => {
    const normalized = normalizeChecks(
      [
        {
          __typename: 'StatusContext',
          id: 'MDQ6VGVzdFN0YXR1c0NvbnRleHQx',
          context: 'external-check',
          state: 'FAILURE',
          description: 'external check failed',
          createdAt: '2026-04-01T00:03:00Z',
          targetUrl: 'https://ci.example.test/build/42'
        }
      ],
      [],
      HEAD
    )
    const observed = review('github', normalized.checks)
    const group = failedCheckGroups(observed, 'all')[0]
    if (!group) {
      throw new Error('expected failed status context group')
    }
    const previousRerun = buildRerunAction(observed, group)
    const ledger: WatcherLedger = {
      watcherId: 'sitter-1',
      entries: [
        {
          kind: 'attempt',
          class: 'fact',
          origin: 'owner',
          watcherId: 'sitter-1',
          eventId: 'failed-status-rerun',
          attemptId: 'failed-status-rerun',
          atMs: 1,
          action: previousRerun,
          fingerprint: hostedReviewAttemptFingerprint(previousRerun),
          state: 'settled',
          effect: 'not-landed'
        }
      ]
    }
    const outcome = explainDesiredAction(observed, definition('github'), ledger, {
      freshness: 'live',
      preparedCommit: null
    })

    expect(normalized.checks[0]).toMatchObject({
      checkId: 'status:MDQ6VGVzdFN0YXR1c0NvbnRleHQx',
      required: false,
      state: 'failed'
    })
    expect(outcome).toMatchObject({
      action: null,
      reason: 'merge-gates-unsatisfied',
      considered: [
        { phase: 'fix-checks', reason: 'check-rerun-unavailable', detail: 'external-check' }
      ]
    })
    expect(deriveHostedReviewSitterDiscrepancies(observed, ledger, 'all')).toMatchObject([
      {
        kind: 'check-failure',
        status: 'escalated'
      }
    ])
    const requiredObserved = review(
      'github',
      normalized.checks.map((check) => ({ ...check, required: true }))
    )
    expect(
      explainDesiredAction(requiredObserved, definition('github', 'required'), emptyLedger(), {
        freshness: 'live',
        preparedCommit: null
      })
    ).toMatchObject({
      action: { kind: 'rerun-check', checkIds: ['status:MDQ6VGVzdFN0YXR1c0NvbnRleHQx'] }
    })
  })

  it('loads optional GitLab external status checks for all scope', async () => {
    mocks.runGitLabApi.mockResolvedValueOnce(
      JSON.stringify([{ id: 91, name: 'deploy', status: 'failed' }])
    )

    const result = await loadExternalStatusChecks(
      definition('gitlab', 'all'),
      git,
      PROJECT_REF,
      HEAD,
      false
    )

    expect(mocks.runGitLabApi).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      complete: true,
      checks: [
        {
          checkId: 'status-check:91',
          name: 'deploy',
          required: false,
          headSha: HEAD,
          state: 'failed'
        }
      ]
    })
    const observed = review('gitlab', result.checks)
    const ledger = emptyLedger()
    const outcome = explainDesiredAction(observed, definition('gitlab'), ledger, {
      freshness: 'live',
      preparedCommit: null
    })
    expect(outcome).toMatchObject({
      action: null,
      considered: [{ phase: 'fix-checks', reason: 'check-rerun-unavailable', detail: 'deploy' }]
    })
    expect(deriveHostedReviewSitterDiscrepancies(observed, ledger, 'all')).toMatchObject([
      {
        kind: 'check-failure',
        status: 'escalated'
      }
    ])
  })

  it('treats a successful empty optional-status response as complete but preserves required mode', async () => {
    mocks.runGitLabApi.mockResolvedValueOnce('[]')
    const allScope = await loadExternalStatusChecks(
      definition('gitlab', 'all'),
      git,
      PROJECT_REF,
      HEAD,
      false
    )

    expect(allScope).toEqual({ checks: [], complete: true })
    expect(mocks.runGitLabApi).toHaveBeenCalledOnce()

    vi.clearAllMocks()
    const requiredScope = await loadExternalStatusChecks(
      definition('gitlab', 'required'),
      git,
      PROJECT_REF,
      HEAD,
      false
    )
    expect(requiredScope).toEqual({ checks: [], complete: true })
    expect(mocks.runGitLabApi).not.toHaveBeenCalled()
  })

  it('normalizes GitLab bridge rows as checks while traversing downstream pipelines', async () => {
    mocks.runGitLabApi.mockImplementation(
      async (
        _definition: HostedReviewSitterDefinition,
        _git: HostedReviewSitterGitExecution,
        _projectRef: ProjectRef,
        args: readonly string[]
      ) => {
        const path = args[0] ?? ''
        if (path.includes('/pipelines/1/bridges?')) {
          return JSON.stringify([
            {
              id: 11,
              name: 'trigger child pipeline',
              stage: 'test',
              status: 'failed',
              allow_failure: false,
              downstream_pipeline: { id: 2, project_id: 7, sha: HEAD }
            }
          ])
        }
        if (path.includes('/pipelines/2/jobs?')) {
          return JSON.stringify([
            {
              id: 22,
              name: 'child test',
              stage: 'test',
              status: 'success',
              allow_failure: false,
              pipeline: { id: 2, sha: HEAD }
            }
          ])
        }
        return '[]'
      }
    )

    const loaded = await loadAllPipelineRows(definition('gitlab', 'all'), git, PROJECT_REF, {
      id: 1,
      sha: HEAD
    })
    const normalized = normalizePipelineJobs(loaded.jobs, HEAD, true, false)

    expect(loaded.complete).toBe(true)
    expect(normalized.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'trigger child pipeline',
          checkId: 'bridge:acme%2Fwidgets:11',
          required: true,
          state: 'failed',
          failureSignature: expect.stringMatching(/^sha256:/)
        }),
        expect.objectContaining({
          name: 'child test',
          checkId: 'job:7:22',
          state: 'passed'
        })
      ])
    )
    mocks.runGitLabApi.mockClear()
    expect(
      await attachGitLabFailureSignatures(
        definition('gitlab', 'all'),
        git,
        PROJECT_REF,
        normalized.checks
      )
    ).toBe(true)
    expect(mocks.runGitLabApi).not.toHaveBeenCalled()
    const observed = review('gitlab', normalized.checks)
    const outcome = explainDesiredAction(
      observed,
      definition('gitlab', 'required'),
      emptyLedger(),
      {
        freshness: 'live',
        preparedCommit: null
      }
    )
    expect(outcome).toMatchObject({
      action: null,
      considered: [{ phase: 'fix-checks', reason: 'check-rerun-unavailable' }]
    })
    expect(
      deriveHostedReviewSitterDiscrepancies(observed, emptyLedger(), 'required')
    ).toMatchObject([{ kind: 'check-failure', status: 'escalated' }])
  })
})
