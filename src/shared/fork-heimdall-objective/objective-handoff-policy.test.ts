import { describe, expect, it } from 'vitest'
import { EnrollInputSchema, type WatcherEnrollment } from '../fork-heimdall/watcher-types'
import type { ObjectiveEnrollmentPayload, ObjectiveSitterOverrides } from './contract-types'
import {
  deriveHandoffInput,
  deriveSitterCapabilities,
  remainingBudget,
  renderReviewBody
} from './objective-handoff-policy'
import type { ObjectivePlan } from './plan-schema'

const CONTRACT: ObjectiveEnrollmentPayload = {
  objectiveText: 'Ship a reliable landing ladder.',
  tier: 'standard',
  landingBar: 'merged',
  maxConcurrency: 2,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

const ENROLLMENT: WatcherEnrollment = {
  watcherId: 'objective-1',
  kind: 'objective',
  workspaceKey: 'local::repo-1',
  executionHostId: 'local',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  workspacePath: '/repo/worktree',
  schedulerOwner: 'local_host_service',
  enabled: true,
  paused: false,
  commandRevision: 0,
  capabilities: {},
  budget: { wallClockActiveMs: 10_000, turns: 10 },
  kindPayload: CONTRACT,
  coordinatorIdentity: { handle: 'coordinator-1', paneKey: 'pane-1' },
  orchestrationRunId: null,
  createdAtMs: 1,
  terminalAtMs: null
}

describe('objective handoff policy', () => {
  it('derives safe capability bases for hosted-review and merged bars', () => {
    expect(deriveSitterCapabilities('hosted-review', {})).toEqual({
      updateBranch: 'gated',
      resolveConflicts: 'off',
      fixChecks: 'gated',
      merge: 'off'
    })
    expect(deriveSitterCapabilities('merged', {})).toEqual({
      updateBranch: 'gated',
      resolveConflicts: 'off',
      fixChecks: 'gated',
      merge: 'gated'
    })
  })

  it.each([
    [{ updateBranch: 'on' }, 'updateBranch', 'on'],
    [{ resolveConflicts: 'gated' }, 'resolveConflicts', 'gated'],
    [{ fixChecks: 'off' }, 'fixChecks', 'off'],
    [{ merge: 'off' }, 'merge', 'off'],
    [{ merge: 'on' }, 'merge', 'gated']
  ] as const)(
    'applies the %s override without allowing an ungated merge',
    (overrides, capability, expected) => {
      expect(
        deriveSitterCapabilities(
          'merged',
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each row above is a hand-authored single-key subset of ObjectiveSitterOverrides; `it.each`'s distributive tuple inference widens it to a union `test.each` can't narrow back on its own.
          overrides as ObjectiveSitterOverrides
        )[capability]
      ).toBe(expected)
    }
  )

  it('subtracts spent budget and floors exhausted dimensions at zero', () => {
    expect(
      remainingBudget(
        { wallClockActiveMs: 1_000, turns: 5 },
        { activeMs: 400, turns: 7, exhausted: { kind: 'turns' } }
      )
    ).toEqual({ wallClockActiveMs: 600, turns: 0 })
    expect(
      remainingBudget(
        { wallClockActiveMs: null, turns: null },
        { activeMs: 400, turns: 7, exhausted: null }
      )
    ).toEqual({ wallClockActiveMs: null, turns: null })
  })

  it('derives an input accepted by the kernel enrollment schema', () => {
    const input = deriveHandoffInput({
      enrollment: ENROLLMENT,
      contract: CONTRACT,
      landing: {
        revisionId: 'revision-1',
        fromContentIdentity: 'content-1',
        provider: 'github',
        reviewNumber: 42,
        reviewUrl: 'https://github.com/acme/repo/pull/42',
        branch: 'feature/objective',
        headSha: 'commit-1',
        base: 'main'
      },
      budgetState: { activeMs: 2_500, turns: 4, exhausted: null }
    })

    expect(EnrollInputSchema.parse(input)).toEqual(input)
    expect(input).toEqual({
      kind: 'hosted-review',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      capabilities: {
        updateBranch: 'gated',
        resolveConflicts: 'off',
        fixChecks: 'gated',
        merge: 'gated'
      },
      budget: { wallClockActiveMs: 7_500, turns: 6 },
      kindPayload: {
        branch: 'feature/objective',
        provider: 'github',
        reviewNumber: 42,
        reviewUrl: 'https://github.com/acme/repo/pull/42',
        branchUpdateMode: 'merge-base-update',
        mergeMethod: null
      }
    })
  })

  it('renders objective text and every acceptance criterion into the review body', () => {
    const plan: ObjectivePlan = [
      {
        taskKey: 'ladder',
        title: 'Landing ladder',
        spec: 'Implement the ladder.',
        deps: [],
        criteria: [
          { body: 'Pushes use leases', shellCheckable: false, checkCommand: null },
          { body: 'Reviews inherit budget', shellCheckable: false, checkCommand: null }
        ],
        declaresDependencyChange: false
      }
    ]
    expect(renderReviewBody(CONTRACT, plan)).toBe(
      'Ship a reliable landing ladder.\n\n## Acceptance criteria\n\n' +
        '- Landing ladder: Pushes use leases\n' +
        '- Landing ladder: Reviews inherit budget'
    )
  })
})
