import { describe, expect, it } from 'vitest'
import type { ApprovalScope, KernelAction } from '../../fork-heimdall/ledger-types'
import {
  answerEvidence,
  attemptEntry,
  emptyLedger,
  pipelinePayload,
  world
} from '../interpreter-test-harness'
import { buildPipelineAction } from './action-envelope'
import {
  actionHasLanded,
  actionIsInFlight,
  answerForAction,
  readPipelineAnswers
} from './choice-rules'
import { derivePipelineRunState } from './run-state'

function scopeFor(action: KernelAction): ApprovalScope {
  return {
    actionKind: action.kind,
    contentIdentity: action.contentIdentity,
    evidenceKey: action.evidenceKey
  }
}

describe('pipeline choice evidence', () => {
  it('keeps answers bound to one exact deadline and counts only settled landed controls as complete', () => {
    const pin = pipelinePayload().pin
    const actionForDeadline = (deadlineMs: number) =>
      buildPipelineAction({
        kind: 'pipeline-apply-choice',
        capability: 'gate',
        visibility: 'local',
        pin,
        instanceId: 'fix',
        nodeId: 'fix',
        epoch: 1,
        attempt: 2,
        cause: 'time-limit',
        deadlineMs,
        fields: { cause: 'time-limit', deadlineMs, options: ['extend', 'retry', 'skip', 'abort'] }
      })
    const firstExpiry = actionForDeadline(61_000)
    const laterExpiry = actionForDeadline(121_000)
    const firstAnswer = answerEvidence(scopeFor(firstExpiry), 'extend', { extendMinutes: 10 })
    let ledger = emptyLedger([firstAnswer])

    expect(readPipelineAnswers(ledger)).toHaveLength(1)
    expect(answerForAction(ledger, firstExpiry)).toMatchObject({
      choice: 'extend',
      extendMinutes: 10
    })
    expect(answerForAction(ledger, laterExpiry)).toBeNull()
    expect(actionHasLanded(ledger, firstExpiry)).toBe(false)

    ledger = emptyLedger([
      firstAnswer,
      attemptEntry(firstExpiry, 'running', 61_000, { attemptId: 'extend-in-flight' })
    ])
    expect(actionIsInFlight(ledger, firstExpiry)).toBe(true)
    expect(actionHasLanded(ledger, firstExpiry)).toBe(false)

    ledger = emptyLedger([
      firstAnswer,
      attemptEntry(firstExpiry, 'settled', 61_001, {
        attemptId: 'extend-did-not-land',
        effect: 'not-landed'
      })
    ])
    expect(actionIsInFlight(ledger, firstExpiry)).toBe(false)
    expect(actionHasLanded(ledger, firstExpiry)).toBe(false)

    ledger = emptyLedger([
      firstAnswer,
      attemptEntry(firstExpiry, 'settled', 61_002, {
        attemptId: 'extend-landed',
        effect: 'landed'
      })
    ])
    expect(actionHasLanded(ledger, firstExpiry)).toBe(true)
    expect(answerForAction(ledger, laterExpiry)).toBeNull()

    const laterAnswer = answerEvidence(scopeFor(laterExpiry), 'retry')
    ledger = emptyLedger([firstAnswer, laterAnswer])
    expect(answerForAction(ledger, firstExpiry)?.choice).toBe('extend')
    expect(answerForAction(ledger, laterExpiry)?.choice).toBe('retry')
  })

  it('applies owner choice intent only to its exact landed control attempt', () => {
    const payload = pipelinePayload(`version: 1
id: owner-attempt
name: Owner attempt
nodes:
  - id: worker
    type: agent
    prompt: Work
    retry: 0
`)
    const run = world({ payload })
    const dispatch = buildPipelineAction({
      kind: 'pipeline-dispatch-agent',
      capability: 'agent',
      visibility: 'external',
      pin: payload.pin,
      instanceId: 'worker',
      nodeId: 'worker',
      epoch: 0,
      attempt: 0
    })
    const failedDispatch = attemptEntry(dispatch, 'settled', 1_000, {
      attemptId: 'worker-failed',
      effect: 'not-landed',
      reason: 'The worker failed'
    })
    const choice = buildPipelineAction({
      kind: 'pipeline-apply-choice',
      capability: 'gate',
      visibility: 'local',
      pin: payload.pin,
      instanceId: 'worker',
      nodeId: 'worker',
      epoch: 0,
      attempt: 1,
      cause: 'retries-exhausted',
      fields: { cause: 'retries-exhausted', choice: 'retry', options: ['retry', 'skip', 'abort'] }
    })
    const landedChoice = attemptEntry(choice, 'settled', 1_003, {
      attemptId: 'owner-choice-attempt',
      effect: 'landed'
    })
    const attribution = {
      actor: { user: 'owner-agent', host: 'laptop' },
      surface: 'owner-agent' as const,
      atMs: 1_002
    }
    const ownerAnswer = (attemptId: string, attemptFingerprint: string) =>
      answerEvidence(scopeFor(choice), 'retry', {
        attribution,
        attemptId,
        attemptFingerprint
      })
    const stateAfter = (evidence: ReturnType<typeof ownerAnswer>, choiceAttempt = landedChoice) =>
      derivePipelineRunState({
        payload,
        ledger: emptyLedger([failedDispatch, evidence, choiceAttempt]),
        facts: run.facts,
        nowMs: 1_004,
        hasOwner: run.hasOwner,
        unverifiableDispatchIds: run.unverifiableDispatchIds,
        composites: run.composites
      })

    const matchingState = stateAfter(ownerAnswer('owner-choice-attempt', landedChoice.fingerprint))
    expect(matchingState.nodes.get('worker')).toMatchObject({
      status: 'ready',
      epoch: 1,
      attempt: 0
    })
    const failedChoice = attemptEntry(choice, 'settled', 1_003, {
      attemptId: 'owner-choice-attempt',
      effect: 'not-landed'
    })
    const unlandedState = stateAfter(
      ownerAnswer('owner-choice-attempt', landedChoice.fingerprint),
      failedChoice
    )
    expect(unlandedState.nodes.get('worker')).toMatchObject({ epoch: 0, attempt: 1 })
    expect(unlandedState.terminal).toBeNull()
    const staleAttemptState = stateAfter(
      ownerAnswer('stale-choice-attempt', landedChoice.fingerprint)
    )
    expect(staleAttemptState.nodes.get('worker')).toMatchObject({ epoch: 0, attempt: 1 })
    expect(staleAttemptState.terminal).toBeNull()
    const staleFingerprintState = stateAfter(
      ownerAnswer('owner-choice-attempt', 'wrong-fingerprint')
    )
    expect(staleFingerprintState.nodes.get('worker')).toMatchObject({ epoch: 0, attempt: 1 })
    expect(staleFingerprintState.terminal).toBeNull()
  })
})
