import { describe, expect, it } from 'vitest'
import type { KernelAction, WatcherLedger } from '../../fork-heimdall/ledger-types'
import { makeAttemptFingerprint } from '../../fork-heimdall/attempt-fingerprint'
import { attemptEntry, emptyLedger, resolved } from '../interpreter-test-harness'
import { scopeLedgerForNode, unwrapCompositeAction, wrapCompositeAction } from './ledger-lens'

function nativeAction(kind: string, identity: string, evidenceKey: string): KernelAction {
  return {
    kind,
    capability: 'git',
    visibility: 'local',
    contentIdentity: identity,
    evidenceKey
  }
}

describe('composite ledger lens', () => {
  it('round-trips a native action and rejects an action without inner identity', () => {
    const inner = nativeAction('hosted-review-merge', 'sitter:head-1', 'merge:head-1')
    const wrapped = wrapCompositeAction('sitter', 2, inner, 'pipeline:run-pin')

    expect(wrapped).toMatchObject({
      contentIdentity: 'pipeline:run-pin',
      pipelineNode: {
        instanceId: 'sitter',
        epoch: 2,
        inner: { contentIdentity: 'sitter:head-1', evidenceKey: 'merge:head-1' }
      }
    })
    expect(unwrapCompositeAction(wrapped)).toEqual(inner)

    const anotherNodeAction: KernelAction = {
      kind: 'pipeline-run-check',
      capability: 'check',
      visibility: 'external',
      contentIdentity: 'pipeline:run-pin',
      evidenceKey: '["node","other",0,0]',
      pipelineNode: { instanceId: 'other', nodeId: 'other', epoch: 0, attempt: 0 }
    }
    expect(unwrapCompositeAction(anotherNodeAction)).toBeNull()
  })

  it('keeps only attempts scoped to the requested node epoch and recomputes inner fingerprints', () => {
    const nativeDispatch = nativeAction(
      'hosted-review-dispatch-agent',
      'sitter:dispatch',
      'dispatch:4'
    )
    const nativeMerge = nativeAction('hosted-review-merge', 'sitter:head-2', 'merge:head-2')
    const scopedDispatch = wrapCompositeAction('sitter', 3, nativeDispatch, 'pipeline:run-pin')
    const scopedMerge = wrapCompositeAction('sitter', 3, nativeMerge, 'pipeline:run-pin')
    const otherNode = wrapCompositeAction(
      'other-sitter',
      3,
      nativeAction('hosted-review-merge', 'other:head', 'merge:other'),
      'pipeline:run-pin'
    )
    const oldEpoch = wrapCompositeAction('sitter', 2, nativeMerge, 'pipeline:run-pin')
    const dispatchAttempt = attemptEntry(scopedDispatch, 'settled', 1_000, {
      attemptId: 'sitter-dispatch',
      effect: 'landed'
    })
    const mergeAttempt = attemptEntry(scopedMerge, 'running', 2_000, {
      attemptId: 'sitter-merge'
    })
    const ledger: WatcherLedger = emptyLedger([
      dispatchAttempt,
      resolved('sitter-dispatch', 'landed'),
      attemptEntry(otherNode, 'settled', 3_000, { attemptId: 'other-node', effect: 'landed' }),
      attemptEntry(oldEpoch, 'settled', 4_000, { attemptId: 'old-epoch', effect: 'landed' }),
      mergeAttempt,
      resolved('sitter-merge', 'landed')
    ])

    const scoped = scopeLedgerForNode(ledger, 'sitter', 3)
    const attempts = scoped.entries.filter((entry) => entry.kind === 'attempt')
    expect(attempts.map((entry) => entry.attemptId)).toEqual(['sitter-dispatch', 'sitter-merge'])
    expect(
      scoped.entries
        .filter((entry) => entry.kind === 'attempt-resolved')
        .map((entry) => entry.attemptId)
    ).toEqual(['sitter-dispatch', 'sitter-merge'])

    const dispatch = attempts.find((entry) => entry.attemptId === 'sitter-dispatch')
    const merge = attempts.find((entry) => entry.attemptId === 'sitter-merge')
    expect(dispatch?.action).toEqual(nativeDispatch)
    expect(merge?.action).toEqual(nativeMerge)
    expect(dispatch?.fingerprint).toBe(
      makeAttemptFingerprint(
        nativeDispatch.contentIdentity,
        nativeDispatch.kind,
        nativeDispatch.evidenceKey
      )
    )
    expect(merge?.fingerprint).toBe(
      makeAttemptFingerprint(nativeMerge.contentIdentity, nativeMerge.kind, nativeMerge.evidenceKey)
    )
    expect(dispatch?.fingerprint).not.toBe(dispatchAttempt.fingerprint)
    expect(merge?.fingerprint).not.toBe(mergeAttempt.fingerprint)
  })
})
