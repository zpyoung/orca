import { describe, expect, it } from 'vitest'
import type {
  ApprovalScope,
  AttemptEntry,
  KernelAction,
  WatcherLedger
} from '../../fork-heimdall/ledger-types'
import { pipelineStopVerdict, type PipelineWorld } from './index'
import { buildPipelineAction } from './action-envelope'
import { decidePipelineTick } from './decide'
import { derivePipelineRunState } from './run-state'
import { loopRoundFacts } from './loop-rules'
import {
  answerEvidence,
  attemptEntry,
  emptyLedger,
  nodeOutputs,
  pipelinePayload,
  world
} from '../interpreter-test-harness'

function loopYaml(maxRounds: number): string {
  return `version: 1
id: loop-run
name: Loop run
nodes:
  - id: planner
    type: agent
    prompt: Draft the change
  - id: review
    type: agent
    after: [planner]
    prompt: Review the change
    outputs:
      verdict:
        type: verdict
  - id: iteration
    type: loop
    after: [review]
    body: [planner, review]
    until: $review.outputs.verdict
    maxRounds: ${maxRounds}
  - id: ship
    type: agent
    after: [iteration]
    prompt: Ship the approved change
`
}

function reviewAction(runWorld: PipelineWorld, epoch = 0): KernelAction {
  return buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'external',
    pin: runWorld.payload.pin,
    instanceId: 'review',
    nodeId: 'review',
    epoch,
    attempt: 0
  })
}

function plannerAction(runWorld: PipelineWorld): KernelAction {
  return buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'external',
    pin: runWorld.payload.pin,
    instanceId: 'planner',
    nodeId: 'planner',
    epoch: 0,
    attempt: 0
  })
}

function runWithVerdict(
  verdict: 'approve' | 'revise' | 'escalate',
  options: { maxRounds?: number; reviewEffect?: 'landed' | 'not-landed' } = {}
) {
  const payload = pipelinePayload(loopYaml(options.maxRounds ?? 2))
  const initialWorld = world({ payload })
  const facts = {
    ...initialWorld.facts,
    outputs: [
      nodeOutputs('review', 0, 0, {
        verdict: {
          verdict,
          objections: ['Update the parser', 'Add an integration case'],
          reason: 'The first draft missed an edge case'
        }
      })
    ]
  }
  const runWorld = world({ payload, facts })
  const ledger = emptyLedger([
    attemptEntry(plannerAction(runWorld), 'settled', 900, { effect: 'landed' }),
    attemptEntry(reviewAction(runWorld), 'settled', 1_000, {
      effect: options.reviewEffect ?? 'landed',
      ...(options.reviewEffect === 'not-landed' ? { reason: 'Review did not land' } : {})
    })
  ])
  return { runWorld, ledger }
}
function runState(runWorld: PipelineWorld, ledger: WatcherLedger) {
  return derivePipelineRunState({
    payload: runWorld.payload,
    ledger,
    facts: runWorld.facts,
    nowMs: runWorld.nowMs
  })
}

function choiceScope(action: KernelAction): ApprovalScope {
  return {
    actionKind: action.kind,
    contentIdentity: action.contentIdentity,
    evidenceKey: action.evidenceKey
  }
}

function requestLoopChoice(
  runWorld: PipelineWorld,
  ledger: WatcherLedger,
  choice: 'accept' | 'one-more-round'
) {
  const offered = decidePipelineTick(runWorld, ledger).action
  expect(offered?.kind).toBe('pipeline-apply-choice')
  if (offered === null || offered.kind !== 'pipeline-apply-choice') {
    throw new Error('Expected a Loop choice action')
  }
  const intent = answerEvidence(choiceScope(offered), choice)
  const answeredLedger = emptyLedger([...ledger.entries, intent])
  const control = decidePipelineTick(runWorld, answeredLedger).action
  expect(control?.kind).toBe('pipeline-apply-choice')
  expect(control?.choice).toBe(choice)
  if (control === null || control.kind !== 'pipeline-apply-choice') {
    throw new Error('Expected the answered Loop control action')
  }
  return { answeredLedger, control }
}

function loopRoundEvidence(attempt: AttemptEntry) {
  return {
    kind: 'evidence' as const,
    eventId: `loop-round:${attempt.attemptId}`,
    watcherId: 'watcher-1',
    atMs: attempt.atMs + 1,
    origin: 'owner' as const,
    class: 'fact' as const,
    evidenceKind: 'pipeline-loop-round',
    payload: {
      loopId: 'iteration',
      epoch: 0,
      round: 2,
      extraRounds: 1,
      attemptId: attempt.attemptId,
      attemptFingerprint: attempt.fingerprint
    }
  }
}

describe('Loop round and choice behavior', () => {
  it('exits on a landed approve verdict and makes the downstream node ready', () => {
    const { runWorld, ledger } = runWithVerdict('approve')

    const state = runState(runWorld, ledger)

    expect(state.nodes.get('iteration')).toMatchObject({
      status: 'done',
      round: 1,
      outputs: {
        verdict: {
          verdict: 'approve',
          objections: ['Update the parser', 'Add an integration case'],
          reason: 'The first draft missed an edge case'
        }
      }
    })
    expect(state.nodes.get('ship')?.status).toBe('ready')
  })

  it('starts the next round after a landed revise verdict, not a failed review', () => {
    const failedReview = runWithVerdict('revise', { reviewEffect: 'not-landed' })
    const failedState = runState(failedReview.runWorld, failedReview.ledger)
    expect(failedState.nodes.get('planner')?.epoch).toBe(0)
    expect(failedState.nodes.get('iteration')?.status).not.toBe('done')

    const landedReview = runWithVerdict('revise')
    const revisedState = runState(landedReview.runWorld, landedReview.ledger)
    expect(revisedState.nodes.get('planner')?.epoch).toBe(1)
    expect(revisedState.nodes.get('review')?.epoch).toBe(1)
    const reentryAction = decidePipelineTick(landedReview.runWorld, landedReview.ledger).action
    expect(reentryAction?.pipelineNode).toMatchObject({
      instanceId: 'planner',
      epoch: 1,
      attempt: 0
    })
    expect(reentryAction).toMatchObject({
      kind: 'pipeline-dispatch-agent',
      spec: expect.stringContaining(
        '## Reviewer objections\nReason: The first draft missed an edge case\nUpdate the parser\nAdd an integration case'
      )
    })
  })

  it.each([
    { verdict: 'escalate' as const, cause: 'loop-escalate', maxRounds: 2 },
    { verdict: 'revise' as const, cause: 'loop-max', maxRounds: 1 }
  ])(
    'offers $cause at the corresponding landed review outcome',
    ({ verdict, cause, maxRounds }) => {
      const { runWorld, ledger } = runWithVerdict(verdict, { maxRounds })

      const outcome = decidePipelineTick(runWorld, ledger)

      expect(outcome.action).toMatchObject({
        kind: 'pipeline-apply-choice',
        cause,
        options: ['accept', 'one-more-round', 'abort']
      })
      expect(runState(runWorld, ledger).nodes.get('iteration')).toMatchObject({
        status: 'waiting',
        waitingFor: 'choice'
      })
    }
  )

  it('commits accept only after the answered Loop control lands', () => {
    const { runWorld, ledger } = runWithVerdict('escalate')
    const { answeredLedger, control } = requestLoopChoice(runWorld, ledger, 'accept')

    expect(runState(runWorld, answeredLedger).nodes.get('iteration')?.status).toBe('waiting')

    const failedControl = attemptEntry(control, 'settled', 2_000, {
      effect: 'not-landed',
      reason: 'Control attempt failed'
    })
    const failedLedger = emptyLedger([...answeredLedger.entries, failedControl])
    expect(runState(runWorld, failedLedger).nodes.get('iteration')?.status).toBe('waiting')
    expect(decidePipelineTick(runWorld, failedLedger).action?.evidenceKey).toBe(control.evidenceKey)

    const landedLedger = emptyLedger([
      ...answeredLedger.entries,
      attemptEntry(control, 'settled', 3_000, { effect: 'landed' })
    ])
    const acceptedState = runState(runWorld, landedLedger)
    expect(acceptedState.nodes.get('iteration')).toMatchObject({
      status: 'done',
      outputs: {
        verdict: {
          verdict: 'escalate',
          objections: ['Update the parser', 'Add an integration case'],
          reason: 'The first draft missed an edge case'
        }
      }
    })
    expect(acceptedState.nodes.get('ship')?.status).toBe('ready')
  })

  it('commits one-more-round only after the answered Loop control lands', () => {
    const { runWorld, ledger } = runWithVerdict('revise', { maxRounds: 1 })
    const { answeredLedger, control } = requestLoopChoice(runWorld, ledger, 'one-more-round')

    expect(runState(runWorld, answeredLedger).nodes.get('planner')?.epoch).toBe(0)

    const failedLedger = emptyLedger([
      ...answeredLedger.entries,
      attemptEntry(control, 'settled', 2_000, { effect: 'not-landed' })
    ])
    expect(runState(runWorld, failedLedger).nodes.get('planner')?.epoch).toBe(0)

    const landedLedger = emptyLedger([
      ...answeredLedger.entries,
      attemptEntry(control, 'settled', 3_000, { effect: 'landed' })
    ])
    const nextRoundState = runState(runWorld, landedLedger)
    expect(nextRoundState.nodes.get('planner')?.epoch).toBe(1)
    expect(nextRoundState.nodes.get('review')?.epoch).toBe(1)
  })

  it('counts Loop round evidence only for its matching settled-landed one-more-round control', () => {
    const { runWorld, ledger } = runWithVerdict('revise', { maxRounds: 1 })
    const { answeredLedger, control } = requestLoopChoice(runWorld, ledger, 'one-more-round')
    const expectedInitialFacts = { round: 1, extraRounds: 0 }
    const attemptedControl = attemptEntry(control, 'attempted', 3_000)
    const failedControl = attemptEntry(control, 'settled', 3_000, { effect: 'not-landed' })
    const landedControl = attemptEntry(control, 'settled', 3_000, { effect: 'landed' })

    expect(
      loopRoundFacts(
        emptyLedger([...answeredLedger.entries, loopRoundEvidence(attemptedControl)]),
        'iteration'
      )
    ).toEqual(expectedInitialFacts)
    expect(
      loopRoundFacts(
        emptyLedger([
          ...answeredLedger.entries,
          attemptedControl,
          loopRoundEvidence(attemptedControl)
        ]),
        'iteration'
      )
    ).toEqual(expectedInitialFacts)
    expect(
      loopRoundFacts(
        emptyLedger([...answeredLedger.entries, failedControl, loopRoundEvidence(failedControl)]),
        'iteration'
      )
    ).toEqual(expectedInitialFacts)
    expect(
      loopRoundFacts(
        emptyLedger([...answeredLedger.entries, landedControl, loopRoundEvidence(landedControl)]),
        'iteration'
      )
    ).toEqual({ round: 2, extraRounds: 1 })
  })
})

describe('Gate intervention behavior', () => {
  const gateYaml = `version: 1
id: gate-run
name: Gate run
nodes:
  - id: planner
    type: agent
    prompt: Draft the change
    retry: 1
  - id: implement
    type: agent
    after: [planner]
    prompt: Implement the change
    retry: 1
  - id: review
    type: gate
    after: [implement]
    label: Human review
    sendBackTo: planner
  - id: publish
    type: agent
    after: [review]
    prompt: Publish the change
`

  function gateFixture() {
    const payload = pipelinePayload(gateYaml)
    const runWorld = world({ payload })
    const settledAgents = ['planner', 'implement'].flatMap((instanceId, index) => {
      const failedAction = buildPipelineAction({
        kind: 'pipeline-dispatch-agent',
        capability: 'agent',
        visibility: 'external',
        pin: payload.pin,
        instanceId,
        nodeId: instanceId,
        epoch: 0,
        attempt: 0
      })
      const landedAction = buildPipelineAction({
        kind: 'pipeline-dispatch-agent',
        capability: 'agent',
        visibility: 'external',
        pin: payload.pin,
        instanceId,
        nodeId: instanceId,
        epoch: 0,
        attempt: 1
      })
      return [
        attemptEntry(failedAction, 'settled', 1_000 + index * 2, {
          effect: 'not-landed',
          reason: 'Retryable draft failure'
        }),
        attemptEntry(landedAction, 'settled', 1_001 + index * 2, { effect: 'landed' })
      ]
    })
    return { runWorld, ledger: emptyLedger(settledAgents) }
  }

  it('advances the send-back path and adds the comment only after the gate control lands', () => {
    const { runWorld, ledger } = gateFixture()
    expect(runState(runWorld, ledger).nodes.get('planner')).toMatchObject({
      status: 'done',
      epoch: 0,
      attempt: 1
    })
    expect(runState(runWorld, ledger).nodes.get('implement')).toMatchObject({
      status: 'done',
      epoch: 0,
      attempt: 1
    })
    const offered = decidePipelineTick(runWorld, ledger).action
    expect(offered).toMatchObject({ kind: 'pipeline-pass-gate', approvalRequired: true })
    if (offered === null || offered.kind !== 'pipeline-pass-gate') {
      throw new Error('Expected the ready gate action')
    }

    const answeredLedger = emptyLedger([
      ...ledger.entries,
      answerEvidence(choiceScope(offered), 'send-back', { comment: 'split step 6' })
    ])
    expect(runState(runWorld, answeredLedger).nodes.get('planner')?.epoch).toBe(0)
    const control = decidePipelineTick(runWorld, answeredLedger).action
    expect(control).toMatchObject({ kind: 'pipeline-pass-gate' })
    if (control === null || control.kind !== 'pipeline-pass-gate') {
      throw new Error('Expected the answered gate control')
    }

    const failedLedger = emptyLedger([
      ...answeredLedger.entries,
      attemptEntry(control, 'settled', 3_000, { effect: 'not-landed' })
    ])
    expect(runState(runWorld, failedLedger).nodes.get('planner')?.epoch).toBe(0)

    const landedLedger = emptyLedger([
      ...answeredLedger.entries,
      attemptEntry(control, 'settled', 4_000, { effect: 'landed' })
    ])
    const sentBackState = runState(runWorld, landedLedger)
    for (const nodeId of ['planner', 'implement', 'review']) {
      expect(sentBackState.nodes.get(nodeId)).toMatchObject({ epoch: 1, attempt: 0 })
    }
    expect(sentBackState.nodes.get('publish')?.epoch).toBe(0)
    expect(decidePipelineTick(runWorld, landedLedger).action).toMatchObject({
      kind: 'pipeline-dispatch-agent',
      pipelineNode: { instanceId: 'planner', epoch: 1 },
      spec: expect.stringContaining('## Send-back comment\nsplit step 6')
    })
  })

  it('aborts the run only after the gate control lands', () => {
    const { runWorld, ledger } = gateFixture()
    const offered = decidePipelineTick(runWorld, ledger).action
    expect(offered).toMatchObject({ kind: 'pipeline-pass-gate' })
    if (offered === null || offered.kind !== 'pipeline-pass-gate') {
      throw new Error('Expected the ready gate action')
    }
    const answeredLedger = emptyLedger([
      ...ledger.entries,
      answerEvidence(choiceScope(offered), 'abort')
    ])
    expect(pipelineStopVerdict(runWorld, answeredLedger)).toBeNull()
    const control = decidePipelineTick(runWorld, answeredLedger).action
    expect(control).toMatchObject({ kind: 'pipeline-pass-gate' })
    if (control === null || control.kind !== 'pipeline-pass-gate') {
      throw new Error('Expected the answered gate control')
    }

    const failedLedger = emptyLedger([
      ...answeredLedger.entries,
      attemptEntry(control, 'settled', 3_000, { effect: 'not-landed' })
    ])
    expect(pipelineStopVerdict(runWorld, failedLedger)).toBeNull()

    const landedLedger = emptyLedger([
      ...answeredLedger.entries,
      attemptEntry(control, 'settled', 4_000, { effect: 'landed' })
    ])
    expect(pipelineStopVerdict(runWorld, landedLedger)).toEqual({ id: 'pipeline-aborted' })
  })
})
