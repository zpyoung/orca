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

  it('keeps an unknown future action kind visible without inventing a label', () => {
    const scope: ApprovalScope = {
      actionKind: 'future-provider-action',
      contentIdentity: 'content',
      evidenceKey: 'evidence'
    }

    expect(approvalActionPresentation(scope, null).title).toBe('future-provider-action')
  })
})
