import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import {
  ObjectiveDetailSchema,
  type ObjectiveDetail
} from '../fork-heimdall-objective/detail-types'
import type {
  HostedReviewSitterAction,
  HostedReviewSitterActionKind
} from '../fork-hosted-review-sitter/types'
import { objectiveCompositePhase, sitterCompositePhase } from './composite-phase'

const OBJECTIVE_CONTRACT: ObjectiveDetail['contract'] = {
  objectiveText: 'Implement the objective',
  tier: 'standard',
  landingBar: 'files-on-disk',
  maxConcurrency: 1,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

function objectiveDetail(overrides: Partial<ObjectiveDetail> = {}): ObjectiveDetail {
  return ObjectiveDetailSchema.parse({
    contract: OBJECTIVE_CONTRACT,
    revisions: [
      {
        id: 'revision-1',
        number: 1,
        status: 'approved',
        digest: 'plan-digest',
        createdAtMs: 10,
        approvedAtMs: 20,
        nodeCount: 1
      }
    ],
    nodes: [
      {
        taskKey: 'core',
        title: 'Core task',
        revisionId: 'revision-1',
        orchestrationTaskId: null,
        dispatchId: null,
        state: 'succeeded',
        criteria: []
      }
    ],
    verdicts: [],
    landing: [],
    asOfMs: 30,
    ...overrides
  })
}

function hostedReviewAction(kind: HostedReviewSitterActionKind): HostedReviewSitterAction {
  const base = {
    contentIdentity: 'content-1',
    evidenceKey: 'evidence-1',
    headSha: 'head-1',
    reviewUrl: 'https://example.com/review/1'
  }
  switch (kind) {
    case 'rerun-check':
      return {
        ...base,
        kind,
        capability: 'fixChecks',
        visibility: 'external',
        expectedState: { target: 'review', before: 'head-1' },
        checkKey: 'tests',
        checkIds: ['check-1'],
        observationIds: ['observation-1'],
        failureSignature: null
      }
    case 'prepare-fix':
      return {
        ...base,
        kind,
        capability: 'fixChecks',
        visibility: 'local',
        checkKey: 'tests',
        checkIds: ['check-1'],
        observationIds: ['observation-1'],
        failureSignature: 'failed-tests',
        evidence: 'fresh-rerun'
      }
    case 'publish-fix':
      return {
        ...base,
        kind,
        capability: 'fixChecks',
        visibility: 'external',
        expectedState: { target: 'review', before: 'head-1' },
        checkKey: 'tests',
        failureSignature: 'failed-tests',
        preparationActionId: 'prepare-1',
        preparedCommitSha: 'commit-1'
      }
    case 'prepare-conflict-resolution':
      return {
        ...base,
        kind,
        capability: 'resolveConflicts',
        visibility: 'local',
        baseSha: 'base-1'
      }
    case 'publish-conflict-resolution':
      return {
        ...base,
        kind,
        capability: 'resolveConflicts',
        visibility: 'external',
        expectedState: { target: 'review', before: 'head-1' },
        baseSha: 'base-1',
        preparationActionId: 'prepare-1',
        preparedCommitSha: 'commit-1'
      }
    case 'update-branch':
      return {
        ...base,
        kind,
        capability: 'updateBranch',
        visibility: 'external',
        expectedState: { target: 'review', before: 'head-1' },
        baseSha: 'base-1',
        mode: 'merge-base-update'
      }
    case 'merge':
      return {
        ...base,
        kind,
        capability: 'merge',
        visibility: 'external',
        expectedState: { target: 'review', before: 'head-1' },
        mergeMethod: 'squash',
        checkScope: 'all'
      }
    case 'enqueue':
      return {
        ...base,
        kind,
        capability: 'merge',
        visibility: 'external',
        expectedState: { target: 'review', before: 'head-1' },
        checkScope: 'all'
      }
  }
}

function ledgerWithInFlightActions(...actions: HostedReviewSitterAction[]): WatcherLedger {
  return {
    watcherId: 'watcher-1',
    entries: actions.map((action, index) => ({
      eventId: `event-${index}`,
      watcherId: 'watcher-1',
      atMs: index,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: `attempt-${index}`,
      fingerprint: `fingerprint-${index}`,
      action,
      state: 'running'
    }))
  }
}

describe('objectiveCompositePhase', () => {
  it('reports planning when there is no approved revision', () => {
    const detail = objectiveDetail({
      revisions: [
        {
          id: 'revision-1',
          number: 1,
          status: 'draft',
          digest: 'plan-digest',
          createdAtMs: 10,
          approvedAtMs: null,
          nodeCount: 1
        }
      ]
    })

    expect(objectiveCompositePhase(detail, null)).toBe('planning')
  })

  it('reports an in-flight plan review from its explicit trace tag', () => {
    const detail = objectiveDetail({
      revisions: [
        {
          id: 'revision-1',
          number: 1,
          status: 'draft',
          digest: 'plan-digest',
          createdAtMs: 10,
          approvedAtMs: null,
          nodeCount: 1
        }
      ]
    })

    expect(objectiveCompositePhase(detail, 'plan-review-in-flight')).toBe('plan-review')
    expect(objectiveCompositePhase(detail, 'plan-review')).toBe('plan-review')
  })

  it('reports implementation as running tasks', () => {
    const detail = objectiveDetail({
      nodes: [
        {
          taskKey: 'core',
          title: 'Core task',
          revisionId: 'revision-1',
          orchestrationTaskId: 'task-1',
          dispatchId: 'dispatch-1',
          state: 'dispatched',
          criteria: []
        }
      ]
    })

    expect(objectiveCompositePhase(detail, 'implementation')).toBe('running-tasks')
  })

  it('reports stale criterion checks and in-flight shell-gate checks', () => {
    const criterionDetail = objectiveDetail({
      nodes: [
        {
          taskKey: 'core',
          title: 'Core task',
          revisionId: 'revision-1',
          orchestrationTaskId: null,
          dispatchId: null,
          state: 'succeeded',
          criteria: [
            {
              id: 'criterion-1',
              body: 'The task satisfies its criterion',
              shellCheckable: true,
              lastCheck: null,
              lastReview: null
            }
          ]
        }
      ]
    })
    const gate = { name: 'test-suite', command: 'pnpm test', timeoutSeconds: 1_800 }
    const gateDetail = objectiveDetail({
      contract: { ...OBJECTIVE_CONTRACT, gates: [gate] },
      gates: [gate]
    })

    expect(objectiveCompositePhase(criterionDetail, null)).toBe('checks')
    expect(objectiveCompositePhase(gateDetail, 'gates')).toBe('checks')
    expect(objectiveCompositePhase(objectiveDetail(), 'checks')).toBe('checks')
  })

  it.each([
    ['review', 'review'],
    ['landing', 'landing'],
    ['landed', 'landed']
  ])('maps the %s trace phase to %s', (tracePhase, expected) => {
    expect(objectiveCompositePhase(objectiveDetail(), tracePhase)).toBe(expected)
  })

  it('reports unknown when neither detail nor trace phase is readable', () => {
    expect(objectiveCompositePhase(null, null)).toBe('unknown')
  })
})

describe('sitterCompositePhase', () => {
  it('reports watching when no hosted-review action is in flight', () => {
    expect(sitterCompositePhase({ watcherId: 'watcher-1', entries: [] })).toBe('watching')
  })

  it('reports the update-branch action separately', () => {
    expect(
      sitterCompositePhase(ledgerWithInFlightActions(hostedReviewAction('update-branch')))
    ).toBe('updating-branch')
  })

  it.each([
    ['rerun-check', 'fixing-checks'],
    ['prepare-fix', 'fixing-checks'],
    ['publish-fix', 'fixing-checks'],
    ['prepare-conflict-resolution', 'resolving-conflicts'],
    ['publish-conflict-resolution', 'resolving-conflicts'],
    ['merge', 'merging'],
    ['enqueue', 'merging']
  ] as const)('maps an in-flight %s action to %s', (kind, expected) => {
    expect(sitterCompositePhase(ledgerWithInFlightActions(hostedReviewAction(kind)))).toBe(expected)
  })
})
