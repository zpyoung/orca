import { afterEach, describe, expect, it } from 'vitest'
import { approvalScopeForAction } from '../../shared/fork-heimdall/gate'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type {
  AttemptEntry,
  KernelAction,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import { WatcherEnrollmentSchema } from '../../shared/fork-heimdall/watcher-types'
import {
  pipelineChoiceOptions,
  type PipelineChoice
} from '../../shared/fork-heimdall-pipeline/choice-types'
import type { PipelineWorld } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { LiveSnapshot } from '../../shared/fork-heimdall/snapshot'
import {
  buildChoiceAction,
  buildGateAction
} from '../../shared/fork-heimdall-pipeline/interpreter/decision-choices'
import { buildPipelineAction } from '../../shared/fork-heimdall-pipeline/interpreter/action-envelope'
import { loopRoundFacts } from '../../shared/fork-heimdall-pipeline/interpreter/loop-rules'
import { derivePipelineRunState } from '../../shared/fork-heimdall-pipeline/interpreter/run-state'
import {
  answerEvidence,
  attemptEntry,
  emptyLedger,
  pipelinePayload,
  world
} from '../../shared/fork-heimdall-pipeline/interpreter-test-harness'
import { PipelineDatabase } from './pipeline-database'
import { PipelineStore } from './pipeline-store'
import {
  executePipelineChoice,
  PipelineChoiceConfigurationError,
  resolvePipelineChoiceOutcome
} from './choice-executor'
import type { PipelineReadyWorld } from './pipeline-kind-read'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'

const GATE_YAML = `version: 1
id: gate-run
name: Gate run
nodes:
  - id: approve
    type: gate
    label: Approve
`

const LOOP_YAML = `version: 1
id: loop-run
name: Loop run
nodes:
  - id: review
    type: agent
    prompt: Review the change
    outputs:
      verdict:
        type: verdict
  - id: iteration
    type: loop
    body: [review]
    until: $review.outputs.verdict
    maxRounds: 1
`

const MERGE_YAML = `version: 1
id: merge-run
name: Merge run
nodes:
  - id: plan
    type: agent
    prompt: Plan the task list
    outputs:
      tasks:
        type: taskList
  - id: swarm
    type: swarm
    after: [plan]
    from: $plan.outputs.tasks
    child:
      harness: codex
      prompt: $task.spec
  - id: merge
    type: merge
    after: [swarm]
    from: swarm
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

const databases: PipelineDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

function storeFixture(): PipelineStore {
  const database = new PipelineDatabase(':memory:')
  databases.push(database)
  return new PipelineStore(database)
}

function readyWorld(base: PipelineWorld, ledger: WatcherLedger): PipelineReadyWorld {
  return { ...base, enrollment: ENROLLMENT, ledger }
}

function contextFor(
  base: PipelineWorld,
  ledger: WatcherLedger,
  appendEvidence?: ExecuteContext<PipelineReadyWorld>['appendEvidence']
): ExecuteContext<PipelineReadyWorld> & { snapshot: LiveSnapshot<PipelineReadyWorld> } {
  const current = readyWorld(base, ledger)
  return {
    snapshot: {
      freshness: 'live',
      contentIdentity: `pipeline:${base.payload.pin.contentHash}`,
      observedAtMs: base.nowMs,
      world: current
    },
    lease: {
      epoch: 1,
      holder: 'test-owner',
      async assertHeld() {},
      renewLoop() {
        return { dispose() {} }
      }
    },
    ledger,
    async dispatchWorker() {
      return { status: 'refused', reason: 'fenced', detail: 'unused in local choice execution' }
    },
    ...(appendEvidence === undefined ? {} : { appendEvidence })
  }
}

function approvedAnswerLedger(action: KernelAction, choice: PipelineChoice) {
  const scope = approvalScopeForAction(action)
  const approvalEventId = `approval:${action.evidenceKey}`
  const ledger = emptyLedger([
    {
      kind: 'approval',
      eventId: approvalEventId,
      watcherId: 'watcher-1',
      atMs: 1_100,
      origin: 'owner',
      class: 'fact',
      scope,
      decision: 'approved',
      foldCount: 1
    },
    answerEvidence(scope, choice, {
      approvalEventId,
      attribution: {
        actor: { user: 'person', host: 'workstation' },
        surface: 'cli',
        atMs: 1_100
      }
    })
  ])
  return ledger
}

function gateAction(base: PipelineWorld): KernelAction {
  const node = base.payload.document.nodes.find((candidate) => candidate.id === 'approve')
  if (node?.type !== 'gate') {
    throw new Error('Expected the Gate fixture node')
  }
  return buildGateAction(base, node, node.id, 0, 0)
}

function controlAttempt(
  action: KernelAction,
  state: AttemptEntry['state'],
  attemptId: string,
  effect?: AttemptEntry['effect']
) {
  return attemptEntry(action, state, 1_200, {
    attemptId,
    ...(effect === undefined ? {} : { effect })
  })
}

describe('pipeline choice executor', () => {
  it('persists Gate outputs before settlement but does not complete the node until its control lands', async () => {
    const store = storeFixture()
    const base = world({ payload: pipelinePayload(GATE_YAML), nowMs: 1_200 })
    const action = gateAction(base)
    const answerLedger = approvedAnswerLedger(action, 'approve')
    const attemptId = 'gate-control'
    const inFlightLedger = emptyLedger([
      ...answerLedger.entries,
      controlAttempt(action, 'attempted', attemptId)
    ])

    const outcome = await executePipelineChoice(action, contextFor(base, inFlightLedger), { store })

    expect(outcome.effect).toBe('landed')
    expect(store.facts('watcher-1').outputs).toContainEqual({
      instanceId: 'approve',
      epoch: 0,
      attempt: 0,
      outputs: { decision: 'approve' },
      reportSha256: null,
      reportSummary: null
    })
    const waiting = derivePipelineRunState({
      payload: base.payload,
      ledger: inFlightLedger,
      facts: store.facts('watcher-1'),
      nowMs: base.nowMs
    })
    expect(waiting.nodes.get('approve')).toMatchObject({ status: 'waiting', waitingFor: 'choice' })

    const landedLedger = emptyLedger([
      ...answerLedger.entries,
      controlAttempt(action, 'settled', attemptId, 'landed')
    ])
    const complete = derivePipelineRunState({
      payload: base.payload,
      ledger: landedLedger,
      facts: store.facts('watcher-1'),
      nowMs: base.nowMs
    })
    expect(complete.nodes.get('approve')).toMatchObject({
      status: 'done',
      outputs: { decision: 'approve' }
    })
  })

  it('settles a no-write person answer only as its exact local control attempt', () => {
    const base = world({
      payload: pipelinePayload(`version: 1
id: abort-run
name: Abort run
nodes:
  - id: fix
    type: agent
    prompt: Fix the issue
`),
      nowMs: 1_250
    })
    const node = base.payload.document.nodes.find((candidate) => candidate.id === 'fix')
    if (node?.type !== 'agent') {
      throw new Error('Expected the Agent fixture node')
    }
    const options = pipelineChoiceOptions({ nodeType: node.type, cause: 'retries-exhausted' })
    const prompt = buildChoiceAction({
      world: base,
      node,
      instanceId: 'fix',
      epoch: 0,
      attempt: 0,
      cause: 'retries-exhausted',
      options,
      detail: 'Retry budget exhausted'
    })
    const action = { ...prompt, choice: 'abort' }
    const answerLedger = approvedAnswerLedger(action, 'abort')
    const attempted = controlAttempt(action, 'attempted', 'abort-control')
    const inFlightLedger = emptyLedger([...answerLedger.entries, attempted])
    const context = contextFor(base, inFlightLedger)

    expect(
      derivePipelineRunState({
        payload: base.payload,
        ledger: inFlightLedger,
        facts: base.facts,
        nowMs: base.nowMs
      }).terminal
    ).toBeNull()
    expect(
      resolvePipelineChoiceOutcome(attempted, context.snapshot, inFlightLedger, context.lease)
    ).toEqual({ effect: 'landed' })
    expect(
      derivePipelineRunState({
        payload: base.payload,
        ledger: emptyLedger([
          ...answerLedger.entries,
          controlAttempt(action, 'settled', 'abort-control', 'landed')
        ]),
        facts: base.facts,
        nowMs: base.nowMs
      }).terminal
    ).toBe('aborted')
  })

  it('persists only the current merge-conflict child skip before settling the local choice', async () => {
    const store = storeFixture()
    const base = world({ payload: pipelinePayload(MERGE_YAML), nowMs: 1_300 })
    const node = base.payload.document.nodes.find((candidate) => candidate.id === 'merge')
    if (node?.type !== 'merge') {
      throw new Error('Expected the Merge fixture node')
    }
    store.setMergeProgress({
      watcherId: 'watcher-1',
      mergeId: 'merge',
      epoch: 0,
      childInstanceId: 'swarm[t2]',
      state: 'applied'
    })
    const options = pipelineChoiceOptions({ nodeType: node.type, cause: 'merge-conflict' })
    const prompt = buildChoiceAction({
      world: base,
      node,
      instanceId: 'merge',
      epoch: 0,
      attempt: 0,
      cause: 'merge-conflict',
      options,
      detail: 'Conflict in src/change.ts',
      fields: {
        conflictingChildInstanceId: 'swarm[t1]',
        conflictingChildren: ['t2'],
        conflictPaths: ['src/change.ts']
      }
    })
    const action = { ...prompt, choice: 'skip' }
    const answerLedger = approvedAnswerLedger(action, 'skip')
    const inFlightLedger = emptyLedger([
      ...answerLedger.entries,
      controlAttempt(action, 'attempted', 'merge-skip')
    ])

    await executePipelineChoice(action, contextFor(base, inFlightLedger), { store })

    expect(store.facts('watcher-1').mergeProgress).toContainEqual({
      mergeId: 'merge',
      epoch: 0,
      childInstanceId: 'swarm[t1]',
      state: 'skipped',
      commitSha: null,
      appliedCommitSha: null,
      conflict: null
    })
    expect(store.facts('watcher-1').mergeProgress).toContainEqual({
      mergeId: 'merge',
      epoch: 0,
      childInstanceId: 'swarm[t2]',
      state: 'applied',
      commitSha: null,
      appliedCommitSha: null,
      conflict: null
    })
    const interrupted = attemptEntry(action, 'attempted', 1_300, { attemptId: 'merge-skip' })
    const resolverContext = contextFor(base, inFlightLedger)
    expect(
      resolvePipelineChoiceOutcome(
        interrupted,
        {
          ...resolverContext.snapshot,
          world: readyWorld({ ...base, facts: store.facts('watcher-1') }, inFlightLedger)
        },
        inFlightLedger,
        resolverContext.lease
      )
    ).toEqual({ effect: 'landed' })
  })

  it('copies Merge progress to the exact next epoch only through a landed retry control', async () => {
    const store = storeFixture()
    const payload = pipelinePayload(MERGE_YAML)
    const initialConflict = {
      paths: ['src/change.ts'],
      conflictingChildren: ['t0']
    }
    store.setMergeProgress({
      watcherId: 'watcher-1',
      mergeId: 'merge',
      epoch: 0,
      childInstanceId: 'swarm[t0]',
      state: 'applied',
      commitSha: 'child-t0',
      appliedCommitSha: 'applied-t0'
    })
    store.setMergeProgress({
      watcherId: 'watcher-1',
      mergeId: 'merge',
      epoch: 0,
      childInstanceId: 'swarm[t1]',
      state: 'resolving',
      commitSha: 'normalized-conflict',
      appliedCommitSha: null,
      conflict: initialConflict
    })
    store.setMergeProgress({
      watcherId: 'watcher-1',
      mergeId: 'merge',
      epoch: 0,
      childInstanceId: 'swarm[t2]',
      state: 'skipped'
    })
    const base = world({ payload, facts: store.facts('watcher-1'), nowMs: 1_700 })
    const node = base.payload.document.nodes.find((candidate) => candidate.id === 'merge')
    if (node?.type !== 'merge') {
      throw new Error('Expected the Merge fixture node')
    }
    const originalMergeAction = buildPipelineAction({
      kind: 'pipeline-merge-child',
      capability: 'integrate',
      visibility: 'local',
      pin: payload.pin,
      instanceId: 'merge',
      nodeId: 'merge',
      epoch: 0,
      attempt: 0,
      step: 'original-merge-step',
      fields: {
        mergeId: 'merge',
        childInstanceId: 'swarm[t1]',
        taskId: 't1',
        childWorkspacePath: '/workspace/swarm/t1',
        childCommitSha: 'source-child-t1',
        sourceHead: 'source-head-t1',
        workspaceDigest: 'source-digest-t1',
        baseCommit: 'base-before-t1',
        appliedChildren: [{ taskId: 't0', commitSha: 'child-t0' }]
      }
    })
    const originalFingerprint = makeAttemptFingerprint(
      originalMergeAction.contentIdentity,
      originalMergeAction.kind,
      originalMergeAction.evidenceKey
    )
    const originalAttempt: AttemptEntry = {
      kind: 'attempt',
      eventId: 'original-merge-conflict',
      watcherId: 'watcher-1',
      atMs: 1_000,
      origin: 'owner',
      class: 'fact',
      attemptId: 'original-merge-attempt',
      fingerprint: originalFingerprint,
      action: originalMergeAction,
      state: 'settled',
      effect: 'not-landed',
      reason: 'merge-conflict',
      result: {
        conflictPaths: initialConflict.paths,
        conflictingChildren: initialConflict.conflictingChildren
      }
    }
    const options = pipelineChoiceOptions({ nodeType: node.type, cause: 'merge-conflict' })
    const prompt = buildChoiceAction({
      world: base,
      node,
      instanceId: 'merge',
      epoch: 0,
      attempt: 1,
      cause: 'merge-conflict',
      options,
      detail: 'Retry the conflict resolver',
      fields: {
        conflictingChildInstanceId: 'swarm[t1]',
        conflictingChildren: ['t0'],
        conflictPaths: initialConflict.paths,
        originalMergeStep: 'original-merge-step',
        originalMergeEpoch: 0,
        originalMergeAttemptId: originalAttempt.attemptId,
        originalMergeAttemptFingerprint: originalFingerprint
      }
    })
    const action = { ...prompt, choice: 'retry' }
    const answerLedger = approvedAnswerLedger(action, 'retry')
    const inFlightLedger = emptyLedger([
      originalAttempt,
      ...answerLedger.entries,
      controlAttempt(action, 'attempted', 'merge-retry')
    ])
    const context = contextFor(base, inFlightLedger)

    await executePipelineChoice(action, context, { store })

    const copied = store.facts('watcher-1').mergeProgress
    expect(copied).toContainEqual({
      mergeId: 'merge',
      epoch: 1,
      childInstanceId: 'swarm[t0]',
      state: 'applied',
      commitSha: 'child-t0',
      appliedCommitSha: 'applied-t0',
      conflict: null
    })
    expect(copied).toContainEqual({
      mergeId: 'merge',
      epoch: 1,
      childInstanceId: 'swarm[t1]',
      state: 'conflict',
      commitSha: 'normalized-conflict',
      appliedCommitSha: null,
      conflict: initialConflict
    })
    expect(copied).toContainEqual({
      mergeId: 'merge',
      epoch: 1,
      childInstanceId: 'swarm[t2]',
      state: 'skipped',
      commitSha: null,
      appliedCommitSha: null,
      conflict: null
    })
    const attemptedState = derivePipelineRunState({
      payload,
      ledger: inFlightLedger,
      facts: store.facts('watcher-1'),
      nowMs: base.nowMs
    })
    expect(attemptedState.nodes.get('merge')?.epoch).toBe(0)
    const landedLedger = emptyLedger([
      ...inFlightLedger.entries,
      controlAttempt(action, 'settled', 'merge-retry', 'landed')
    ])
    const landedState = derivePipelineRunState({
      payload,
      ledger: landedLedger,
      facts: store.facts('watcher-1'),
      nowMs: base.nowMs
    })
    expect(landedState.nodes.get('merge')?.epoch).toBe(1)
  })
  it('correlates Loop round evidence to one-more-round and counts it only after that control lands', async () => {
    const base = world({ payload: pipelinePayload(LOOP_YAML), nowMs: 1_400 })
    const node = base.payload.document.nodes.find((candidate) => candidate.id === 'iteration')
    if (node?.type !== 'loop') {
      throw new Error('Expected the Loop fixture node')
    }
    const options = pipelineChoiceOptions({ nodeType: node.type, cause: 'loop-max' })
    const prompt = buildChoiceAction({
      world: base,
      node,
      instanceId: 'iteration',
      epoch: 0,
      attempt: 0,
      cause: 'loop-max',
      options,
      detail: 'Maximum rounds reached'
    })
    const action = { ...prompt, choice: 'one-more-round' }
    const answerLedger = approvedAnswerLedger(action, 'one-more-round')
    const attemptId = 'loop-control'
    const attempted = controlAttempt(action, 'attempted', attemptId)
    const inFlightLedger = emptyLedger([...answerLedger.entries, attempted])
    const emitted: { kind: string; payload: Readonly<Record<string, unknown>> }[] = []

    await executePipelineChoice(
      action,
      contextFor(base, inFlightLedger, async (kind, payload) => {
        emitted.push({ kind, payload })
      }),
      { store: storeFixture() }
    )

    expect(emitted).toEqual([
      {
        kind: 'pipeline-loop-round',
        payload: { loopId: 'iteration', epoch: 0, round: 2, extraRounds: 1 }
      }
    ])
    const fingerprint = makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    )
    const roundEvidence = {
      kind: 'evidence' as const,
      eventId: 'loop-round-evidence',
      watcherId: 'watcher-1',
      atMs: 1_401,
      origin: 'owner' as const,
      class: 'fact' as const,
      evidenceKind: 'pipeline-loop-round',
      payload: {
        loopId: 'iteration',
        epoch: 0,
        round: 2,
        extraRounds: 1,
        attemptId,
        attemptFingerprint: fingerprint
      }
    }
    const correlatedLedger = emptyLedger([...inFlightLedger.entries, roundEvidence])
    const resolverContext = contextFor(base, correlatedLedger)
    expect(
      resolvePipelineChoiceOutcome(
        attempted,
        resolverContext.snapshot,
        correlatedLedger,
        resolverContext.lease
      )
    ).toEqual({ effect: 'landed' })
    expect(loopRoundFacts(correlatedLedger, 'iteration')).toEqual({ round: 1, extraRounds: 0 })

    const wrongAttemptId = {
      ...roundEvidence,
      eventId: 'wrong-loop-attempt',
      payload: { ...roundEvidence.payload, attemptId: 'another-control' }
    }
    const wrongFingerprint = {
      ...roundEvidence,
      eventId: 'wrong-loop-fingerprint',
      payload: { ...roundEvidence.payload, attemptFingerprint: 'another-fingerprint' }
    }
    const wrongRound = {
      ...roundEvidence,
      eventId: 'wrong-loop-round',
      payload: { ...roundEvidence.payload, round: 3 }
    }
    for (const evidence of [wrongAttemptId, wrongFingerprint, wrongRound]) {
      const wrongLedger = emptyLedger([...inFlightLedger.entries, evidence])
      const wrongContext = contextFor(base, wrongLedger)
      expect(
        resolvePipelineChoiceOutcome(
          attempted,
          wrongContext.snapshot,
          wrongLedger,
          wrongContext.lease
        )
      ).toEqual({ effect: 'not-landed' })
      expect(
        loopRoundFacts(
          emptyLedger([
            ...wrongLedger.entries,
            controlAttempt(action, 'settled', attemptId, 'not-landed')
          ]),
          'iteration'
        )
      ).toEqual({ round: 1, extraRounds: 0 })
    }
    expect(
      loopRoundFacts(
        emptyLedger([
          ...correlatedLedger.entries,
          controlAttempt(action, 'settled', attemptId, 'landed')
        ]),
        'iteration'
      )
    ).toEqual({ round: 2, extraRounds: 1 })
  })
  it('records owner-answer evidence on owner-agent surface and fails configuration without its writer', async () => {
    const store = storeFixture()
    const base = world({
      payload: pipelinePayload(`version: 1
id: owner-evidence
name: Owner evidence
nodes:
  - id: fix
    type: agent
    prompt: Fix the issue
    retry: 0
`),
      nowMs: 1_500
    })
    const node = base.payload.document.nodes.find((candidate) => candidate.id === 'fix')
    if (node?.type !== 'agent') {
      throw new Error('Expected the Agent fixture node')
    }
    const options = pipelineChoiceOptions({ nodeType: node.type, cause: 'retries-exhausted' })
    const prompt = buildChoiceAction({
      world: base,
      node,
      instanceId: 'fix',
      epoch: 0,
      attempt: 1,
      cause: 'retries-exhausted',
      options,
      detail: 'Retry budget exhausted'
    })
    const action = { ...prompt, choice: 'retry', approvalRequired: false, ownerIntervention: true }
    const ledger = emptyLedger([controlAttempt(action, 'attempted', 'owner-choice')])
    const evidence: { kind: string; payload: Readonly<Record<string, unknown>> }[] = []

    await executePipelineChoice(
      action,
      contextFor(base, ledger, async (kind, payload) => {
        evidence.push({ kind, payload })
      }),
      { store }
    )

    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({
      kind: 'pipeline-answer',
      payload: {
        scope: {
          actionKind: 'pipeline-apply-choice',
          contentIdentity: `pipeline:${base.payload.pin.contentHash}`,
          evidenceKey: action.evidenceKey
        },
        choice: 'retry',
        attribution: { surface: 'owner-agent', atMs: base.nowMs }
      }
    })
    await expect(
      executePipelineChoice(action, contextFor(base, ledger), { store })
    ).rejects.toBeInstanceOf(PipelineChoiceConfigurationError)
    const fingerprint = makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    )
    const priorAnswer = {
      kind: 'evidence' as const,
      eventId: 'prior-owner-answer',
      watcherId: 'watcher-1',
      atMs: 1_400,
      origin: 'owner' as const,
      class: 'fact' as const,
      evidenceKind: 'pipeline-answer',
      payload: {
        approvalEventId: `owner-agent:${fingerprint}`,
        scope: {
          actionKind: action.kind,
          contentIdentity: action.contentIdentity,
          evidenceKey: action.evidenceKey
        },
        choice: 'retry',
        attribution: {
          actor: { user: 'owner', host: 'workstation' },
          surface: 'owner-agent',
          atMs: 1_400
        },
        attemptId: 'prior-owner-attempt',
        attemptFingerprint: fingerprint
      }
    }
    const retryLedger = emptyLedger([
      priorAnswer,
      controlAttempt(action, 'attempted', 'next-owner-attempt')
    ])
    const retryEvidence: { kind: string; payload: Readonly<Record<string, unknown>> }[] = []
    await executePipelineChoice(
      action,
      contextFor(base, retryLedger, async (kind, payload) => {
        retryEvidence.push({ kind, payload })
      }),
      { store }
    )
    expect(retryEvidence).toHaveLength(1)
    expect(retryEvidence[0]).toMatchObject({
      kind: 'pipeline-answer',
      payload: {
        choice: 'retry',
        attribution: { surface: 'owner-agent' }
      }
    })
    const emittedAnswer = retryEvidence[0]
    if (emittedAnswer === undefined) {
      throw new Error('Expected a fresh owner pipeline-answer evidence payload')
    }
    const retryFingerprint = makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    )
    const currentAttemptAnswer = {
      kind: 'evidence' as const,
      eventId: 'current-owner-answer',
      watcherId: 'watcher-1',
      atMs: 1_501,
      origin: 'owner' as const,
      class: 'fact' as const,
      evidenceKind: 'pipeline-answer',
      payload: {
        ...emittedAnswer.payload,
        attemptId: 'next-owner-attempt',
        attemptFingerprint: retryFingerprint
      }
    }
    const correlatedLedger = emptyLedger([...retryLedger.entries, currentAttemptAnswer])
    const resolverContext = contextFor(base, correlatedLedger)
    expect(
      resolvePipelineChoiceOutcome(
        controlAttempt(action, 'attempted', 'next-owner-attempt'),
        resolverContext.snapshot,
        correlatedLedger,
        resolverContext.lease
      )
    ).toEqual({ effect: 'landed' })
  })
})
