import { describe, expect, it } from 'vitest'
import { approvalScopeForAction, gateAction } from '../../shared/fork-heimdall/gate'
import type {
  ApprovalEntry,
  ApprovalScope,
  EscalationEntry,
  KernelAction,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { OwnerStateBrief } from '../../shared/fork-heimdall/kind-contract'
import type { PipelineNodeDeviation } from '../../shared/fork-heimdall/owner/deviation'
import type { Intervention } from '../../shared/fork-heimdall/owner/intervention'
import { RetryRungInterventionSchema } from '../../shared/fork-hosted-review-sitter/owner-intervention'
import { WatcherEnrollmentSchema } from '../../shared/fork-heimdall/watcher-types'
import type {
  PipelineWorld,
  PipelineComposite
} from '../../shared/fork-heimdall-pipeline/interpreter'
import { buildPipelineAction } from '../../shared/fork-heimdall-pipeline/interpreter/action-envelope'
import { decidePipelineTick } from '../../shared/fork-heimdall-pipeline/interpreter/decide'
import {
  makePipelineNodeEvidenceKey,
  type PipelineChoice
} from '../../shared/fork-heimdall-pipeline/choice-types'
import { wrapCompositeAction } from '../../shared/fork-heimdall-pipeline/interpreter/ledger-lens'
import {
  answerEvidence,
  attemptEntry,
  emptyLedger,
  ownerEscalation as makeOwnerEscalation,
  pipelinePayload,
  world
} from '../../shared/fork-heimdall-pipeline/interpreter-test-harness'
import type { PipelineCompositeOwnerContext, PipelineCompositeOwnerDelegate } from './pipeline-kind'
import type { PipelineReadyWorld } from './pipeline-kind-read'
import { createPipelineOwnerAdapter, PipelineChoiceInterventionSchema } from './owner-adapter'

const FAILURE_YAML = `version: 1
id: owner-run
name: Owner run
nodes:
  - id: fix
    type: agent
    prompt: Fix the issue
    retry: 0
`

const READY_SIBLING_FAILURE_YAML = `version: 1
id: owner-run-with-sibling
name: Owner run with sibling
nodes:
  - id: sibling
    type: agent
    prompt: Complete sibling work
  - id: fix
    type: agent
    prompt: Fix the issue
    retry: 0
`

const TIME_LIMIT_YAML = `version: 1
id: timed-run
name: Timed run
nodes:
  - id: worker
    type: agent
    prompt: Work on the issue
    timeLimitMinutes: 1
    retry: 0
`

const SITTER_YAML = `version: 1
id: sitter-run
name: Sitter run
nodes:
  - id: sitter
    type: pr-sitter
    mergeCheckScope: required
`

const ENROLLMENT = WatcherEnrollmentSchema.parse({
  watcherId: 'watcher-1',
  kind: 'pipeline',
  workspaceKey: 'local::/workspace',
  executionHostId: 'local',
  repoId: 'repo-1',
  worktreeId: null,
  workspacePath: '/workspace',
  schedulerOwner: 'local_host_service',
  enabled: true,
  paused: false,
  commandRevision: 0,
  capabilities: { gate: 'on' },
  budget: { wallClockActiveMs: null, turns: null },
  kindPayload: {},
  coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
  orchestrationRunId: null,
  createdAtMs: 0,
  terminalAtMs: null
})

type OwnerRun = Readonly<{
  base: PipelineWorld

  world: PipelineReadyWorld
  ledger: WatcherLedger
  snapshot: {
    freshness: 'live'
    contentIdentity: string
    observedAtMs: number
    world: PipelineReadyWorld
  }
  deviation: PipelineNodeDeviation
  escalation: EscalationEntry
}>
const NO_SITTER_COMPOSITE_OWNER: PipelineCompositeOwnerDelegate = {
  interventionSchema: RetryRungInterventionSchema,
  isSitterIntervention(intervention) {
    return intervention.kind === 'retry-rung'
  },
  describeInterventions() {
    return 'retry a PR-sitter rung'
  },
  describeState() {
    return { text: 'PR-sitter state', truncated: false }
  },
  rejectIntervention() {
    return null
  },
  actionForIntervention() {
    return {
      kind: 'pr-sitter-retry',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'pr-sitter-test',
      evidenceKey: 'pr-sitter-test-step'
    }
  }
}

function readyOwnerRun(base: PipelineWorld, ledger: WatcherLedger): PipelineReadyWorld {
  return { ...base, enrollment: ENROLLMENT, ledger }
}

function snapshotFor(base: PipelineWorld, ledger: WatcherLedger) {
  const current = readyOwnerRun(base, ledger)
  return {
    freshness: 'live' as const,
    contentIdentity: `pipeline:${base.payload.pin.contentHash}`,
    observedAtMs: base.nowMs,
    world: current
  }
}

function failureOwnerRun(yamlText = FAILURE_YAML): OwnerRun {
  const base = world({ payload: pipelinePayload(yamlText), nowMs: 2_000, hasOwner: true })
  const failedAction = buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'local',
    pin: base.payload.pin,
    instanceId: 'fix',
    nodeId: 'fix',
    epoch: 0,
    attempt: 0
  })
  const failureLedger = emptyLedger([
    attemptEntry(failedAction, 'settled', 1_000, {
      attemptId: 'worker-failed',
      effect: 'not-landed',
      reason: 'The worker failed'
    })
  ])
  const decision = decidePipelineTick(base, failureLedger)
  if (!('deviation' in decision) || decision.deviation.kind !== 'pipeline-node') {
    throw new Error('Expected a current pipeline-node retry deviation')
  }
  const deviation = decision.deviation
  const escalation = ownerEscalation(deviation, 'open')
  const ledger = emptyLedger([...failureLedger.entries, escalation])
  return {
    base,
    world: readyOwnerRun(base, ledger),
    ledger,
    snapshot: snapshotFor(base, ledger),
    deviation,
    escalation
  }
}

function timedOwnerRun(): OwnerRun {
  const base = world({ payload: pipelinePayload(TIME_LIMIT_YAML), nowMs: 61_001, hasOwner: true })
  const action = buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'local',
    pin: base.payload.pin,
    instanceId: 'worker',
    nodeId: 'worker',
    epoch: 0,
    attempt: 0
  })
  const inFlight = emptyLedger([
    attemptEntry(action, 'running', 1_000, { attemptId: 'worker-running' })
  ])
  const decision = decidePipelineTick(base, inFlight)
  if (!('deviation' in decision) || decision.deviation.kind !== 'pipeline-node') {
    throw new Error('Expected a current pipeline-node time-limit deviation')
  }
  const deviation = decision.deviation
  const escalation = ownerEscalation(deviation, 'open')
  const ledger = emptyLedger([...inFlight.entries, escalation])
  return {
    base,
    world: readyOwnerRun(base, ledger),
    ledger,
    snapshot: snapshotFor(base, ledger),
    deviation,
    escalation
  }
}

function intervention(run: OwnerRun, choice: PipelineChoice) {
  return {
    kind: 'pipeline-choice' as const,
    escalationId: run.escalation.escalationId,
    nodeInstanceId: run.deviation.nodeInstanceId,
    choice
  }
}

function replaceOpenDeviation(run: OwnerRun, deviation: PipelineNodeDeviation) {
  const escalation = ownerEscalation(deviation, 'open')
  const ledger = emptyLedger([
    ...run.ledger.entries.filter(
      (entry) => entry.kind !== 'escalation' || entry.escalationId !== run.escalation.escalationId
    ),
    escalation
  ])
  return { escalation, ledger }
}

function approvalEntry(scope: ApprovalScope, eventId: string): ApprovalEntry {
  return {
    kind: 'approval',
    eventId,
    watcherId: 'watcher-1',
    atMs: 2_100,
    origin: 'owner',
    class: 'fact',
    scope,
    decision: 'approved',
    foldCount: 1
  }
}

function ownerEscalation(
  deviation: PipelineNodeDeviation,
  status: EscalationEntry['status']
): EscalationEntry {
  const entry = makeOwnerEscalation(deviation, status)
  const summary = deviation.detail ? `${deviation.kind}: ${deviation.detail}` : deviation.kind
  return {
    ...entry,
    reason: JSON.stringify({ summary, note: 'recorded', deviation })
  }
}

function sitterOwnerRun(): OwnerRun & {
  compositeAction: KernelAction
  compositeOwner: PipelineCompositeOwnerDelegate
} {
  const base = world({ payload: pipelinePayload(SITTER_YAML), nowMs: 2_500, hasOwner: true })
  const nativeAction: KernelAction = {
    kind: 'sitter-native-action',
    capability: 'updateBranch',
    visibility: 'local',
    contentIdentity: 'sitter-inner-run',
    evidenceKey: 'sitter-inner-step'
  }
  const compositeAction = wrapCompositeAction(
    'sitter',
    0,
    nativeAction,
    `pipeline:${base.payload.pin.contentHash}`
  )
  const innerSnapshot = {
    freshness: 'live' as const,
    contentIdentity: 'sitter-inner-run',
    observedAtMs: base.nowMs,
    world: { phase: 'reviewing' }
  }
  const composite: PipelineComposite = {
    snapshot: innerSnapshot,
    phase: 'reviewing',
    decide() {
      return { action: null, reason: 'stopped', considered: [] }
    },
    evaluateStops() {
      return { predicateId: 'owner-stall', disposition: 'park', reason: 'The sitter is waiting' }
    }
  }
  const facts = {
    ...base.facts,
    composites: [
      {
        instanceId: 'sitter',
        epoch: 0,
        kind: 'hosted-review' as const,
        kindPayload: {},
        capabilities: {},
        activatedAtMs: 1_000
      }
    ]
  }
  const compositeWorld = world({
    ...base,
    facts,
    composites: { sitter: composite }
  })
  const innerAttempt = attemptEntry(compositeAction, 'settled', 1_100, {
    attemptId: 'sitter-action',
    effect: 'landed'
  })
  const beforeOpen = emptyLedger([innerAttempt])
  const decision = decidePipelineTick(compositeWorld, beforeOpen)
  if (!('deviation' in decision) || decision.deviation.kind !== 'pipeline-node') {
    throw new Error('Expected a current pipeline-node sitter deviation')
  }
  const deviation = decision.deviation
  const escalation = ownerEscalation(deviation, 'open')
  const ledger = emptyLedger([...beforeOpen.entries, escalation])
  const ready = readyOwnerRun(compositeWorld, ledger)
  const run: OwnerRun = {
    base: compositeWorld,
    world: ready,
    ledger,
    snapshot: snapshotFor(compositeWorld, ledger),
    deviation,
    escalation
  }
  const compositeOwner: PipelineCompositeOwnerDelegate = {
    interventionSchema: RetryRungInterventionSchema,
    isSitterIntervention(value: Intervention) {
      return value.kind === 'retry-rung'
    },
    describeInterventions() {
      return 'retry the current sitter rung'
    },
    describeState(): OwnerStateBrief {
      return { text: 'sitter owner state', truncated: false }
    },
    rejectIntervention() {
      return null
    },
    actionForIntervention() {
      return nativeAction
    }
  }
  return { ...run, compositeAction, compositeOwner }
}

describe('pipeline owner adapter', () => {
  it.each(['retry', 'skip', 'abort'] as const)(
    'creates the exact local, unapproved %s retry control',
    (choice) => {
      const run = failureOwnerRun()
      const adapter = createPipelineOwnerAdapter({ compositeOwner: NO_SITTER_COMPOSITE_OWNER })
      const answer = intervention(run, choice)
      expect(PipelineChoiceInterventionSchema.parse(answer)).toEqual(answer)
      expect(adapter.rejectIntervention(answer, run.snapshot, run.ledger, ENROLLMENT)).toBeNull()

      const action = adapter.actionForIntervention(answer, run.snapshot, run.ledger)
      expect(action).toMatchObject({
        kind: 'pipeline-apply-choice',
        capability: 'gate',
        visibility: 'local',
        contentIdentity: `pipeline:${run.base.payload.pin.contentHash}`,
        cause: 'retries-exhausted',
        choice,
        options: ['retry', 'skip', 'abort'],
        approvalRequired: false,
        ownerIntervention: true,
        pipelineNode: {
          instanceId: 'fix',
          nodeId: 'fix',
          epoch: 0,
          attempt: 1
        }
      })
      expect(action).not.toHaveProperty('approvalEventId')
    }
  )

  it('answers the exact open choice while an unrelated sibling remains ready', () => {
    const run = failureOwnerRun(READY_SIBLING_FAILURE_YAML)
    const adapter = createPipelineOwnerAdapter({ compositeOwner: NO_SITTER_COMPOSITE_OWNER })

    expect(decidePipelineTick(run.base, run.ledger).action).toMatchObject({
      kind: 'pipeline-dispatch-agent',
      pipelineNode: { instanceId: 'sibling' }
    })
    const answer = intervention(run, 'retry')
    expect(adapter.rejectIntervention(answer, run.snapshot, run.ledger, ENROLLMENT)).toBeNull()
    expect(adapter.actionForIntervention(answer, run.snapshot, run.ledger)).toMatchObject({
      kind: 'pipeline-apply-choice',
      choice: 'retry',
      pipelineNode: { instanceId: 'fix' }
    })
  })

  it('preserves the original deadline for an owner extend and refuses gate approvals', () => {
    const timed = timedOwnerRun()
    const adapter = createPipelineOwnerAdapter({ compositeOwner: NO_SITTER_COMPOSITE_OWNER })
    const extend = { ...intervention(timed, 'extend'), extendMinutes: 10 }
    expect(adapter.rejectIntervention(extend, timed.snapshot, timed.ledger, ENROLLMENT)).toBeNull()
    const extendAction = adapter.actionForIntervention(extend, timed.snapshot, timed.ledger)
    expect(extendAction).toMatchObject({
      cause: 'time-limit',
      deadlineMs: 61_000,
      choice: 'extend',
      extendMinutes: 10,
      approvalRequired: false
    })
    expect(extendAction.evidenceKey).toBe(
      makePipelineNodeEvidenceKey({
        instanceId: 'worker',
        epoch: 0,
        attempt: 0,
        cause: 'time-limit',
        deadlineMs: 61_000
      })
    )

    const failed = failureOwnerRun()
    const refusal = adapter.rejectIntervention(
      intervention(failed, 'approve'),
      failed.snapshot,
      failed.ledger,
      ENROLLMENT
    )
    expect(refusal).toMatchObject({ gate: 'pipeline-choice' })
  })

  it('rejects an open owner choice after its node epoch or timeout deadline changes', () => {
    const adapter = createPipelineOwnerAdapter({ compositeOwner: NO_SITTER_COMPOSITE_OWNER })
    const failed = failureOwnerRun()
    const staleEpochDeviation = { ...failed.deviation, epoch: failed.deviation.epoch + 1 }
    const staleEpoch = replaceOpenDeviation(failed, staleEpochDeviation)
    expect(
      adapter.rejectIntervention(
        {
          ...intervention(failed, 'retry'),
          escalationId: staleEpoch.escalation.escalationId
        },
        failed.snapshot,
        staleEpoch.ledger,
        ENROLLMENT
      )
    ).toMatchObject({ gate: 'pipeline-choice' })

    const timed = timedOwnerRun()
    const staleDeadlineDeviation = {
      ...timed.deviation,
      deadlineMs: (timed.deviation.deadlineMs ?? 0) + 1
    }
    const staleDeadline = replaceOpenDeviation(timed, staleDeadlineDeviation)
    expect(
      adapter.rejectIntervention(
        {
          ...intervention(timed, 'extend'),
          escalationId: staleDeadline.escalation.escalationId,
          extendMinutes: 10
        },
        timed.snapshot,
        staleDeadline.ledger,
        ENROLLMENT
      )
    ).toMatchObject({ gate: 'pipeline-choice' })
  })

  it('rejects stale deviations and only refuses approvals from the exact choice scope', () => {
    const run = failureOwnerRun()
    const adapter = createPipelineOwnerAdapter({ compositeOwner: NO_SITTER_COMPOSITE_OWNER })
    const choice = intervention(run, 'retry')
    expect(
      adapter.rejectIntervention(
        { ...choice, escalationId: `${choice.escalationId}:stale` },
        run.snapshot,
        run.ledger,
        ENROLLMENT
      )
    ).toMatchObject({ gate: 'pipeline-choice' })

    const action = adapter.actionForIntervention(choice, run.snapshot, run.ledger)
    const exactScope = approvalScopeForAction(action)
    const unrelatedApproval = approvalEntry(
      { ...exactScope, evidenceKey: `${exactScope.evidenceKey}:another-scope` },
      'unrelated-approval'
    )
    const unrelatedLedger = emptyLedger([...run.ledger.entries, unrelatedApproval])
    expect(adapter.rejectIntervention(choice, run.snapshot, unrelatedLedger, ENROLLMENT)).toBeNull()

    const exactApproval = approvalEntry(exactScope, 'person-approval')
    const exactLedger = emptyLedger([...run.ledger.entries, exactApproval])
    expect(adapter.rejectIntervention(choice, run.snapshot, exactLedger, ENROLLMENT)).toMatchObject(
      {
        gate: 'pipeline-choice'
      }
    )
  })

  it('keeps an earlier owner answer pending instead of accepting a replacement', () => {
    const run = failureOwnerRun()
    const adapter = createPipelineOwnerAdapter({ compositeOwner: NO_SITTER_COMPOSITE_OWNER })
    const firstChoice = intervention(run, 'skip')
    const action = adapter.actionForIntervention(firstChoice, run.snapshot, run.ledger)
    const pendingAttempt = attemptEntry(action, 'settled', 2_099, {
      attemptId: 'prior-owner-attempt',
      effect: 'not-landed'
    })
    const priorAnswer = answerEvidence(approvalScopeForAction(action), 'skip', {
      attribution: {
        actor: { user: 'owner', host: 'workstation' },
        surface: 'owner-agent',
        atMs: 2_100
      },
      attemptId: pendingAttempt.attemptId,
      attemptFingerprint: pendingAttempt.fingerprint
    })
    const ledger = emptyLedger([...run.ledger.entries, pendingAttempt, priorAnswer])

    expect(
      adapter.rejectIntervention(intervention(run, 'retry'), run.snapshot, ledger, ENROLLMENT)
    ).toMatchObject({ gate: 'pipeline-choice' })
    expect(decidePipelineTick(run.world, ledger)).toMatchObject({
      action: {
        kind: 'pipeline-apply-choice',
        choice: 'skip',
        evidenceKey: action.evidenceKey
      }
    })
  })

  it('delegates sitter owner state/actions only for the exact open sitter deviation and wraps one native action', () => {
    const run = sitterOwnerRun()
    const sitterIntervention = {
      kind: 'retry-rung',
      rung: 'update-branch',
      rationale: 'Retry the current branch update'
    }
    const contextSeen: PipelineCompositeOwnerContext[] = []
    const delegate: PipelineCompositeOwnerDelegate = {
      ...run.compositeOwner,
      describeState(input) {
        contextSeen.push(input)
        return { text: 'sitter owner state', truncated: false }
      },
      rejectIntervention(_value, context) {
        contextSeen.push(context)
        return null
      },
      actionForIntervention(value, context) {
        contextSeen.push(context)
        return run.compositeOwner.actionForIntervention(value, context)
      }
    }
    const delegatingAdapter = createPipelineOwnerAdapter({ compositeOwner: delegate })
    delegatingAdapter.describeState(run.snapshot, run.ledger, 1_000, {
      deviation: run.deviation
    })
    expect(contextSeen[0]?.nodeInstanceId).toBe('sitter')
    expect(contextSeen[0]?.scopedLedger.entries[0]).toMatchObject({
      kind: 'attempt',
      action: {
        kind: 'sitter-native-action',
        contentIdentity: 'sitter-inner-run',
        evidenceKey: 'sitter-inner-step'
      }
    })

    expect(
      delegatingAdapter.rejectIntervention(sitterIntervention, run.snapshot, run.ledger, ENROLLMENT)
    ).toBeNull()
    const wrapped = delegatingAdapter.actionForIntervention(
      sitterIntervention,
      run.snapshot,
      run.ledger
    )
    expect(wrapped).toMatchObject({
      kind: 'sitter-native-action',
      contentIdentity: `pipeline:${run.base.payload.pin.contentHash}`,
      pipelineNode: {
        instanceId: 'sitter',
        nodeId: 'sitter',
        epoch: 0,
        inner: { contentIdentity: 'sitter-inner-run', evidenceKey: 'sitter-inner-step' }
      }
    })

    const closedLedger = emptyLedger([
      ...run.ledger.entries,
      ownerEscalation(run.deviation, 'resolved')
    ])
    expect(
      delegatingAdapter.rejectIntervention(
        sitterIntervention,
        run.snapshot,
        closedLedger,
        ENROLLMENT
      )
    ).toMatchObject({ gate: 'sitter-overrides' })
  })
  it('keeps the sitter merge approval separate from a gate scope and refreshes it for a new PR head', () => {
    const run = sitterOwnerRun()
    const reviewUrl = 'https://example.test/review/1'
    const nativeMerge: KernelAction = {
      kind: 'merge',
      capability: 'merge',
      visibility: 'external',
      contentIdentity: 'sitter-head-old',
      evidenceKey: 'merge:head-old',
      headSha: 'head-old',
      reviewUrl,
      expectedState: { target: reviewUrl, before: 'head-old' },
      mergeMethod: 'squash',
      checkScope: 'required'
    }
    const oldAction = wrapCompositeAction(
      'sitter',
      0,
      nativeMerge,
      `pipeline:${run.base.payload.pin.contentHash}`
    )
    const newAction = wrapCompositeAction(
      'sitter',
      0,
      {
        ...nativeMerge,
        contentIdentity: 'sitter-head-new',
        evidenceKey: 'merge:head-new',
        headSha: 'head-new',
        expectedState: { target: reviewUrl, before: 'head-new' }
      },
      `pipeline:${run.base.payload.pin.contentHash}`
    )
    const precedingGateApproval = approvalEntry(
      {
        actionKind: 'pipeline-pass-gate',
        contentIdentity: oldAction.contentIdentity,
        evidenceKey: 'preceding-gate'
      },
      'preceding-gate-approval'
    )
    const oldMergeApproval = approvalEntry(approvalScopeForAction(oldAction), 'old-merge-approval')
    const newMergeApproval = approvalEntry(approvalScopeForAction(newAction), 'new-merge-approval')
    const mergeEnrollment = {
      enabled: true,
      capabilities: { merge: 'gated' },
      budget: ENROLLMENT.budget
    } as const

    expect(newAction.evidenceKey).not.toBe(oldAction.evidenceKey)
    expect(
      gateAction(oldAction, run.snapshot, mergeEnrollment, emptyLedger([precedingGateApproval]))
    ).toMatchObject({
      verdict: 'hold',
      reason: 'awaiting-approval',
      escalation: { approvalScope: approvalScopeForAction(oldAction) }
    })
    expect(
      gateAction(
        oldAction,
        run.snapshot,
        mergeEnrollment,
        emptyLedger([precedingGateApproval, oldMergeApproval])
      )
    ).toEqual({ verdict: 'allow' })
    expect(
      gateAction(
        newAction,
        run.snapshot,
        mergeEnrollment,
        emptyLedger([precedingGateApproval, oldMergeApproval])
      )
    ).toMatchObject({
      verdict: 'hold',
      reason: 'awaiting-approval',
      escalation: { approvalScope: approvalScopeForAction(newAction) }
    })
    expect(
      gateAction(
        newAction,
        run.snapshot,
        mergeEnrollment,
        emptyLedger([precedingGateApproval, oldMergeApproval, newMergeApproval])
      )
    ).toEqual({ verdict: 'allow' })
  })
})
