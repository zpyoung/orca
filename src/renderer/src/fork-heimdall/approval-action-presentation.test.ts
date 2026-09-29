import { describe, expect, it } from 'vitest'
import { createTickTrace, type WatcherTickTrace } from '../../../shared/fork-heimdall/tick-trace'
import type { ApprovalScope, KernelAction } from '../../../shared/fork-heimdall/ledger-types'
import { approvalActionPresentation, latestApprovalAction } from './approval-action-presentation'

const RUNNER: WatcherTickTrace['runner'] = {
  consecutiveErrors: 0,
  lastFullResyncAtMs: null,
  reconcileAgain: false
}

function trace(seq: number, action: KernelAction): WatcherTickTrace {
  const result = createTickTrace(seq, seq * 1_000, RUNNER)
  result.decision = { action }
  return result
}

function publishFixAction(
  overrides: Partial<KernelAction> & Pick<KernelAction, 'contentIdentity' | 'evidenceKey'>
): KernelAction {
  return {
    kind: 'publish-fix',
    capability: 'fixChecks',
    visibility: 'external',
    preparedCommitSha: 'prepared-target',
    expectedState: { target: 'review-branch', before: 'head-before' },
    headSha: 'head-before',
    reviewUrl: 'https://example.test/review/1',
    checkKey: 'target-check',
    failureSignature: 'failure',
    preparationActionId: 'preparation-target',
    ...overrides
  }
}

describe('approval action presentation', () => {
  it.each([
    { checkScope: 'all', label: 'All checks' },
    { checkScope: 'required', label: 'Required checks only' }
  ] as const)('shows the $checkScope policy for merge approvals', ({ checkScope, label }) => {
    const action: KernelAction = {
      kind: 'merge',
      capability: 'merge',
      visibility: 'external',
      contentIdentity: 'merge-content',
      evidenceKey: 'merge-evidence',
      checkScope
    }
    const presentation = approvalActionPresentation(
      {
        actionKind: 'merge',
        contentIdentity: 'merge-content',
        evidenceKey: 'merge-evidence'
      },
      action
    )

    expect(presentation.details).toContainEqual({
      label: 'Merge check scope',
      value: label
    })
  })
  it('enriches from only a complete approval-scope match', () => {
    const scope: ApprovalScope = {
      actionKind: 'publish-fix',
      contentIdentity: 'content-target',
      evidenceKey: 'evidence-target',
      preparedCommitSha: 'prepared-target'
    }
    const exact = publishFixAction({
      contentIdentity: scope.contentIdentity,
      evidenceKey: scope.evidenceKey
    })
    const traces = [
      trace(1, exact),
      trace(
        2,
        publishFixAction({
          contentIdentity: 'content-newer',
          evidenceKey: scope.evidenceKey,
          checkKey: 'wrong-content-check'
        })
      ),
      trace(
        3,
        publishFixAction({
          contentIdentity: scope.contentIdentity,
          evidenceKey: 'evidence-newer',
          checkKey: 'wrong-evidence-check'
        })
      ),
      trace(
        4,
        publishFixAction({
          contentIdentity: scope.contentIdentity,
          evidenceKey: scope.evidenceKey,
          preparedCommitSha: 'prepared-newer',
          checkKey: 'wrong-commit-check'
        })
      )
    ]

    const action = latestApprovalAction(traces, scope)
    const presentation = approvalActionPresentation(scope, action)

    expect(presentation.details.map((detail) => detail.value)).toContain('target-check')
    expect(presentation.details).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: expect.stringContaining('wrong-') })
      ])
    )
  })

  it('labels a run-gate action with its own title and explanation', () => {
    const scope: ApprovalScope = {
      actionKind: 'run-gate',
      contentIdentity: 'content-current',
      evidenceKey: 'objective-gate:full-suite:content-current'
    }
    const action: KernelAction = {
      kind: 'run-gate',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'objective-gate:full-suite:content-current',
      gateName: 'full-suite',
      command: 'pnpm test',
      timeoutSeconds: 1_800
    }

    const presentation = approvalActionPresentation(scope, action)

    expect(presentation.title).toBe('Run objective gate')
    expect(presentation.explanation).toBe(
      'Run a whole-tree command on the integrated branch before review and landing.'
    )
    expect(presentation.details.map((detail) => detail.value)).toContain('pnpm test')
  })

  it('labels an apply-plan-patch action with its own title and explanation', () => {
    const scope: ApprovalScope = {
      actionKind: 'apply-plan-patch',
      contentIdentity: 'content-current',
      evidenceKey: 'plan-patch:patch-1'
    }
    const action: KernelAction = {
      kind: 'apply-plan-patch',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan-patch:patch-1',
      recovery: 'replay-safe',
      revisionId: 'revision-1',
      patchId: 'patch-1',
      digest: 'patch-digest-1'
    }

    const presentation = approvalActionPresentation(scope, action)

    expect(presentation.title).toBe('Apply plan repair')
    expect(presentation.explanation).toBe(
      'Apply a planner repair patch to the approved objective plan.'
    )
    expect(presentation.details.map((detail) => detail.value)).toContain('revision-1')
  })

  it('labels a dispatch-plan-review action with its own title and explanation', () => {
    const scope: ApprovalScope = {
      actionKind: 'dispatch-plan-review',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:1'
    }
    const action: KernelAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:1',
      target: { kind: 'revision', revisionId: 'revision-1' },
      round: 1
    }

    const presentation = approvalActionPresentation(scope, action)

    expect(presentation.title).toBe('Review the plan')
    expect(presentation.explanation).toBe(
      'Start the plan critic review of a draft revision or a pending patch.'
    )
  })

  it('labels an ingest-plan-review action with its own title and explanation', () => {
    const scope: ApprovalScope = {
      actionKind: 'ingest-plan-review',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-plan-review-1'
    }
    const action: KernelAction = {
      kind: 'ingest-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-plan-review-1',
      recovery: 'replay-safe',
      dispatchId: 'dispatch-plan-review-1',
      reportPath: '/outside/plan-review.json',
      target: { kind: 'patch', patchId: 'patch-1' }
    }

    const presentation = approvalActionPresentation(scope, action)

    expect(presentation.title).toBe('Record the plan review')
    expect(presentation.explanation).toBe('Read a plan review verdict into the objective state.')
  })

  it('keeps an unknown future action kind visible without inventing a label', () => {
    const scope: ApprovalScope = {
      actionKind: 'future-provider-action',
      contentIdentity: 'content',
      evidenceKey: 'evidence'
    }

    expect(approvalActionPresentation(scope, null).title).toBe('future-provider-action')
  })
})
