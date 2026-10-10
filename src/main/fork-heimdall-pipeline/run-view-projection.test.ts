import { describe, expect, it } from 'vitest'
import { buildWatcherFleetEntry } from '../../shared/fork-heimdall/fleet-test-fixtures'
import { approvalScopeForAction } from '../../shared/fork-heimdall/gate'
import {
  AttemptEntrySchema,
  EscalationEntrySchema,
  TurnEntrySchema,
  type ApprovalScope
} from '../../shared/fork-heimdall/ledger-types'
import { WatcherListEntrySchema } from '../../shared/fork-heimdall/watcher-types'
import { ObjectiveEnrollmentPayloadSchema } from '../../shared/fork-heimdall-objective/contract-types'
import { ObjectiveDetailSchema } from '../../shared/fork-heimdall-objective/detail-types'
import { buildPipelineAction } from '../../shared/fork-heimdall-pipeline/interpreter/action-envelope'
import { buildGateAction } from '../../shared/fork-heimdall-pipeline/interpreter/decision-choices'
import {
  attemptEntry,
  emptyLedger,
  pipelinePayload,
  world
} from '../../shared/fork-heimdall-pipeline/interpreter-test-harness'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { scriptApprovalDigest } from '../../shared/fork-heimdall-pipeline/script-env'
import { makePipelineNodeEvidenceKey } from '../../shared/fork-heimdall-pipeline/choice-types'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import { projectPipelineRunView } from './run-view-projection'
const OBJECTIVE_GATE = { name: 'lint', command: 'pnpm lint', timeoutSeconds: 30 }
const OBJECTIVE_CONTRACT = ObjectiveEnrollmentPayloadSchema.parse({
  objectiveText: 'Implement the requested work',
  tier: 'standard',
  landingBar: 'files-on-disk',
  maxConcurrency: 1,
  workspaceKind: 'git',
  writeTerritory: ['**'],
  roleAgents: {},
  sitterOverrides: {},
  gates: [OBJECTIVE_GATE]
})

function watcherEntry(
  kind: 'pipeline' | 'objective' | 'hosted-review',
  kindPayload: unknown,
  phase: string
) {
  const base = buildWatcherFleetEntry(1).entry
  return WatcherListEntrySchema.parse({
    ...base,
    enrollment: { ...base.enrollment, kind, kindPayload },
    status: { ...base.status, phase }
  })
}

function objectiveDetail() {
  return ObjectiveDetailSchema.parse({
    contract: OBJECTIVE_CONTRACT,
    revisions: [
      {
        id: 'revision-1',
        number: 4,
        status: 'approved',
        digest: 'plan-digest',
        createdAtMs: 10,
        approvedAtMs: 20,
        nodeCount: 1
      }
    ],
    nodes: [
      {
        taskKey: 'task-1',
        title: 'Implement the fix',
        revisionId: 'revision-1',
        orchestrationTaskId: null,
        dispatchId: null,
        state: 'succeeded',
        criteria: []
      }
    ],
    verdicts: [],
    landing: [],
    gates: [
      {
        ...OBJECTIVE_GATE,
        lastResult: {
          contentIdentity: 'content-1',
          pass: true,
          exitCode: 0,
          timedOut: false,
          completedAtMs: 40
        }
      }
    ],
    asOfMs: 50
  })
}
function awaitingApproval(
  scope: ApprovalScope,
  escalationId: string,
  status: 'open' | 'resolved' = 'open'
) {
  return EscalationEntrySchema.parse({
    eventId: `${escalationId}:${status}`,
    watcherId: 'watcher-1',
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId,
    escalationKind: 'awaiting-approval',
    status,
    foldCount: 1,
    approvalScope: scope
  })
}

describe('projectPipelineRunView', () => {
  it('projects a live human gate hold as waiting on its exact unresolved scope', () => {
    const payload = pipelinePayload(`version: 1
id: approval-pipeline
name: Approval pipeline
nodes:
  - id: approve
    type: gate
    label: Approve deployment
`)
    const gateNode = payload.document.nodes.find((node) => node.type === 'gate')
    if (gateNode?.type !== 'gate') {
      throw new Error('Expected the approval fixture to contain a gate')
    }
    const pipelineWorld = world({ payload })
    const action = buildGateAction(pipelineWorld, gateNode, 'approve', 0, 0)
    const scope = approvalScopeForAction(action)
    const staleContent = { ...scope, contentIdentity: 'pipeline:sha256:previous-content' }
    const ledger = emptyLedger([
      awaitingApproval(scope, 'gate-current'),
      awaitingApproval(staleContent, 'gate-stale-content')
    ])
    const view = projectPipelineRunView({
      entry: watcherEntry('pipeline', payload, 'waiting'),
      ledger,
      facts: pipelineWorld.facts,
      nowMs: 50,
      unverifiableDispatchIds: new Set()
    })

    expect(view.nodes.find((node) => node.nodeId === 'approve')).toMatchObject({
      instanceId: 'approve',
      status: 'waiting',
      waitingFor: 'gate',
      escalationId: 'gate-current',
      epoch: 0,
      attempt: 0
    })
    const resolvedView = projectPipelineRunView({
      entry: watcherEntry('pipeline', payload, 'waiting'),
      ledger: emptyLedger([awaitingApproval(scope, 'gate-resolved', 'resolved')]),
      facts: pipelineWorld.facts,
      nowMs: 50,
      unverifiableDispatchIds: new Set()
    })
    const resolvedNode = resolvedView.nodes.find((node) => node.nodeId === 'approve')
    expect(resolvedNode).toMatchObject({ status: 'pending', waitingFor: null })
    expect(resolvedNode).not.toHaveProperty('escalationId')
  })

  it('projects an ordinary Script capability hold only for the current scoped attempt', () => {
    const payload = pipelinePayload(`version: 1
id: script-approval-pipeline
name: Script approval pipeline
nodes:
  - id: publish
    type: script
    command: printf ready
    capability: script
`)
    const scriptNode = payload.document.nodes.find((node) => node.type === 'script')
    if (scriptNode?.type !== 'script') {
      throw new Error('Expected the capability fixture to contain a Script node')
    }
    const pipelineWorld = world({ payload })
    const action = buildPipelineAction({
      kind: 'pipeline-run-script',
      capability: 'script',
      visibility: 'external',
      pin: payload.pin,
      instanceId: scriptNode.id,
      nodeId: scriptNode.id,
      epoch: 0,
      attempt: 0,
      step: `script:${scriptApprovalDigest({ command: scriptNode.command, env: {} })}`
    })
    const scope = approvalScopeForAction(action)
    const previousContent = { ...scope, contentIdentity: 'pipeline:sha256:previous-content' }
    const ledger = emptyLedger([
      awaitingApproval(previousContent, 'script-previous-content'),
      awaitingApproval(scope, 'script-current')
    ])
    const view = projectPipelineRunView({
      entry: watcherEntry('pipeline', payload, 'waiting'),
      ledger,
      facts: pipelineWorld.facts,
      nowMs: 50,
      unverifiableDispatchIds: new Set()
    })

    expect(view.nodes.find((node) => node.nodeId === 'publish')).toMatchObject({
      instanceId: 'publish',
      status: 'waiting',
      waitingFor: 'capability-approval',
      escalationId: 'script-current',
      epoch: 0,
      attempt: 0
    })
    const staleStepScope = {
      ...scope,
      evidenceKey: makePipelineNodeEvidenceKey({
        instanceId: 'publish',
        epoch: 0,
        attempt: 0,
        step: `script:${scriptApprovalDigest({ command: 'printf stale', env: {} })}`
      })
    }
    const staleStepView = projectPipelineRunView({
      entry: watcherEntry('pipeline', payload, 'waiting'),
      ledger: emptyLedger([awaitingApproval(staleStepScope, 'script-stale-step')]),
      facts: pipelineWorld.facts,
      nowMs: 50,
      unverifiableDispatchIds: new Set()
    })
    const staleStepNode = staleStepView.nodes.find((node) => node.nodeId === 'publish')
    expect(staleStepNode).toMatchObject({ status: 'pending', waitingFor: null })
    expect(staleStepNode).not.toHaveProperty('escalationId')
  })
  it('projects a current Land push hold as a capability approval with its native step', () => {
    const payload = pipelinePayload(`version: 1
id: land-approval-pipeline
name: Land approval pipeline
nodes:
  - id: publish
    type: land
`)
    const pipelineWorld = world({ payload })
    const action = buildPipelineAction({
      kind: 'pipeline-land-push',
      capability: 'push',
      visibility: 'external',
      pin: payload.pin,
      instanceId: 'publish',
      nodeId: 'publish',
      epoch: 0,
      attempt: 0,
      step: JSON.stringify(['pipeline-land-push', 'main', 'origin', 'main', 'head', 'before'])
    })
    const scope = approvalScopeForAction(action)
    const completedCommit = buildPipelineAction({
      kind: 'pipeline-land-commit',
      capability: 'land',
      visibility: 'local',
      pin: payload.pin,
      instanceId: 'publish',
      nodeId: 'publish',
      epoch: 0,
      attempt: 0
    })
    const ledger = emptyLedger([
      attemptEntry(completedCommit, 'settled', 20, { effect: 'landed' }),
      awaitingApproval(scope, 'land-push-current')
    ])
    const view = projectPipelineRunView({
      entry: watcherEntry('pipeline', payload, 'waiting'),
      ledger,
      facts: pipelineWorld.facts,
      nowMs: 50,
      unverifiableDispatchIds: new Set()
    })

    expect(view.nodes.find((node) => node.nodeId === 'publish')).toMatchObject({
      status: 'waiting',
      waitingFor: 'capability-approval',
      escalationId: 'land-push-current'
    })
    const staleCommitView = projectPipelineRunView({
      entry: watcherEntry('pipeline', payload, 'waiting'),
      ledger: emptyLedger([
        attemptEntry(completedCommit, 'settled', 20, { effect: 'landed' }),
        awaitingApproval(approvalScopeForAction(completedCommit), 'land-commit-stale')
      ]),
      facts: pipelineWorld.facts,
      nowMs: 50,
      unverifiableDispatchIds: new Set()
    })
    const staleCommitNode = staleCommitView.nodes.find((node) => node.nodeId === 'publish')
    expect(staleCommitNode).toMatchObject({ status: 'pending', waitingFor: null })
    expect(staleCommitNode).not.toHaveProperty('escalationId')
  })
  it('projects active node attempts, elapsed time, turns, immutable pins and worker uncertainty', () => {
    const payload = pipelinePayload()
    const startedAtMs = 200
    const action = buildPipelineAction({
      kind: 'pipeline-dispatch-agent',
      capability: 'agent',
      visibility: 'local',
      pin: payload.pin,
      instanceId: 'repro',
      nodeId: 'repro',
      epoch: 0,
      attempt: 0,
      fields: { dispatchId: 'dispatch-1' }
    })
    const attempt = attemptEntry(action, 'running', startedAtMs, {
      attemptId: 'attempt-1',
      dispatchId: 'dispatch-1'
    })
    const turn = TurnEntrySchema.parse({
      eventId: 'turn-1',
      watcherId: 'watcher-1',
      atMs: 800,
      origin: 'owner',
      class: 'fact',
      kind: 'turn',
      dispatchKind: 'planner',
      dispatchId: 'dispatch-1'
    })
    const ledger = emptyLedger([attempt, turn])
    const facts = {
      ...world({ payload }).facts,
      pin: { ...payload.pin, runNumber: 8 },
      dispatches: [
        {
          instanceId: 'repro',
          epoch: 0,
          attempt: 0,
          dispatchId: 'dispatch-1',
          workspaceId: 'worktree-1',
          terminalHandle: 'term_1',
          reportPath: '/tmp/report.json',
          dispatchedAtMs: startedAtMs
        }
      ]
    }
    const entry = watcherEntry('pipeline', payload, 'worker-unverifiable')
    const view = projectPipelineRunView({
      entry,
      ledger,
      facts,
      workers: [
        {
          dispatchId: 'dispatch-1',
          task: 'Reproduce the bug',
          dispatchedAtMs: startedAtMs,
          lastContactAtMs: 800,
          liveness: 'unverifiable',
          reason: 'contact lost',
          question: null,
          navigation: {
            worktreeId: 'worktree-1',
            executionHostId: 'local',
            paneKey: 'pane-1'
          }
        }
      ],
      nowMs: 1_000,
      unverifiableDispatchIds: new Set(['dispatch-1'])
    })
    const repro = view.nodes.find((node) => node.nodeId === 'repro')

    expect(view.pin).toMatchObject({
      ref: payload.pin.ref,
      runNumber: 8,
      contentHash: payload.pin.contentHash
    })
    expect(repro).toMatchObject({
      instanceId: 'repro',
      status: 'unverifiable',
      epoch: 0,
      attempt: 0,
      startedAtMs,
      elapsedMs: 800,
      turns: 1,
      workerNavigation: {
        worktreeId: 'worktree-1',
        executionHostId: 'local',
        paneKey: 'pane-1'
      }
    })
    expect(view.nodes).toHaveLength(2)
  })
  it('folds private Merge conflict-resolver activity into its authored node', () => {
    const payload = pipelinePayload(`version: 1
id: merge-plan
name: Merge plan
nodes:
  - id: tasks
    type: agent
    prompt: Create child tasks
    outputs:
      tasks:
        type: taskList
  - id: swarm
    type: swarm
    from: $tasks.outputs.tasks
    child:
      harness: claude
      prompt: Work on the task
  - id: merge
    type: merge
    from: swarm
`)
    const childAction = buildPipelineAction({
      kind: 'pipeline-dispatch-agent',
      capability: 'agent',
      visibility: 'local',
      pin: payload.pin,
      instanceId: 'swarm[child-a]',
      nodeId: 'swarm',
      epoch: 0,
      attempt: 0
    })
    const resolverAction = buildPipelineAction({
      kind: 'pipeline-resolve-merge-conflict',
      capability: 'agent',
      visibility: 'local',
      pin: payload.pin,
      instanceId: 'merge[child-a]',
      nodeId: 'merge',
      epoch: 0,
      attempt: 0,
      fields: { mergeId: 'merge', childInstanceId: 'swarm[child-a]', taskId: 'child-a' }
    })
    const ledger = emptyLedger([
      attemptEntry(childAction, 'settled', 450, { attemptId: 'attempt-child', effect: 'landed' }),
      attemptEntry(resolverAction, 'running', 500, { attemptId: 'attempt-resolver' }),
      ...[400, 800].map((atMs, index) =>
        TurnEntrySchema.parse({
          eventId: `turn-merge-${index}`,
          watcherId: 'watcher-1',
          atMs,
          origin: 'owner',
          class: 'fact',
          kind: 'turn',
          dispatchKind: 'child',
          dispatchId: 'child-dispatch-1'
        })
      )
    ])
    const facts = {
      ...world({ payload }).facts,
      dispatches: [
        {
          instanceId: 'swarm[child-a]',
          epoch: 0,
          attempt: 0,
          dispatchId: 'child-dispatch-1',
          workspaceId: 'worktree-1',
          terminalHandle: 'term-merge',
          reportPath: '/tmp/merge-report.json',
          dispatchedAtMs: 300
        }
      ],
      swarmExpansions: [
        {
          swarmId: 'swarm',
          epoch: 0,
          tasks: [{ id: 'child-a', title: 'Child task', spec: 'Resolve the conflict' }],
          warnings: [],
          baseCommit: null
        }
      ],
      mergeProgress: [
        {
          mergeId: 'merge',
          epoch: 0,
          childInstanceId: 'swarm[child-a]',
          state: 'resolving' as const,
          commitSha: 'child-commit',
          appliedCommitSha: null,
          conflict: { paths: ['file.txt'], conflictingChildren: ['swarm[child-a]'] }
        }
      ]
    }
    const view = projectPipelineRunView({
      entry: watcherEntry('pipeline', payload, 'acting'),
      ledger,
      facts,
      workers: [
        {
          dispatchId: 'child-dispatch-1',
          task: 'Resolve merge conflict',
          dispatchedAtMs: 300,
          lastContactAtMs: 800,
          liveness: 'live',
          reason: null,
          question: null,
          navigation: { worktreeId: 'worktree-1', executionHostId: 'local', paneKey: 'merge-pane' }
        }
      ],
      nowMs: 1_000,
      unverifiableDispatchIds: new Set()
    })
    const merge = view.nodes.find((node) => node.instanceId === 'merge')
    const child = view.nodes.find((node) => node.instanceId === 'swarm[child-a]')

    expect(merge).toMatchObject({
      nodeId: 'merge',
      turns: 1,
      startedAtMs: 500,
      elapsedMs: 500,
      workerNavigation: {
        worktreeId: 'worktree-1',
        executionHostId: 'local',
        paneKey: 'merge-pane'
      }
    })
    expect(child).toMatchObject({ turns: 1, startedAtMs: 300, elapsedMs: 150 })
    expect(child).not.toHaveProperty('workerNavigation')
  })

  it('projects Objective revision progress and latest check results with the legacy built-in pin', () => {
    const entry = watcherEntry('objective', OBJECTIVE_CONTRACT, 'implementation')
    const view = projectPipelineRunView({
      entry,
      ledger: emptyLedger(),
      facts: { ...world().facts, pin: null },
      objectiveDetail: objectiveDetail(),
      nowMs: 500,
      unverifiableDispatchIds: new Set()
    })

    expect(view.pin).toMatchObject({
      ref: 'builtin:objective',
      runNumber: null,
      label: 'Objective v1'
    })
    expect(view.nodes[0]).toMatchObject({
      nodeId: 'objective',
      phase: 'running-tasks',
      revision: 4,
      progress: { done: 1, total: 1 },
      checks: [{ name: 'lint', result: { pass: true, exitCode: 0 } }]
    })
  })

  it('uses the plan-review trace reason but never infers that phase from completed review rows', () => {
    const completedReview = {
      contract: OBJECTIVE_CONTRACT,
      revisions: [],
      nodes: [],
      verdicts: [],
      landing: [],
      planReviews: [
        {
          targetKind: 'revision',
          targetId: 'revision-1',
          round: 1,
          verdict: 'approve',
          createdAtMs: 10,
          summary: 'Plan review completed'
        }
      ],
      asOfMs: 20
    }
    const parsedDetail = ObjectiveDetailSchema.parse(completedReview)
    const notInFlight = projectPipelineRunView({
      entry: watcherEntry('objective', OBJECTIVE_CONTRACT, 'planning'),
      ledger: emptyLedger(),
      facts: { ...world().facts, pin: null },
      objectiveDetail: parsedDetail,
      nowMs: 100,
      unverifiableDispatchIds: new Set()
    })
    const traceReason = projectPipelineRunView({
      entry: watcherEntry('objective', OBJECTIVE_CONTRACT, 'plan-review-in-flight'),
      ledger: emptyLedger(),
      facts: { ...world().facts, pin: null },
      objectiveDetail: parsedDetail,
      nowMs: 100,
      unverifiableDispatchIds: new Set()
    })

    const planReviewAttempt = AttemptEntrySchema.parse({
      eventId: 'event-plan-review',
      watcherId: 'watcher-1',
      atMs: 25,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-plan-review',
      fingerprint: 'plan-review-fingerprint',
      action: {
        kind: 'dispatch-plan-review',
        capability: 'review',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'plan-review:revision:revision-1:1',
        target: { kind: 'revision', revisionId: 'revision-1' },
        round: 1
      },
      state: 'running'
    })
    const dispatchInFlight = projectPipelineRunView({
      entry: watcherEntry('objective', OBJECTIVE_CONTRACT, 'planning'),
      ledger: emptyLedger([planReviewAttempt]),
      facts: { ...world().facts, pin: null },
      objectiveDetail: parsedDetail,
      nowMs: 100,
      unverifiableDispatchIds: new Set()
    })
    expect(notInFlight.nodes[0]?.phase).toBe('planning')
    expect(traceReason.nodes[0]?.phase).toBe('plan-review')
    expect(dispatchInFlight.nodes[0]?.phase).toBe('plan-review')
  })

  it('projects the captured terminal node outcomes instead of treating compacted nodes as pending', () => {
    const payload = pipelinePayload(`version: 1
id: terminal-projection
name: Terminal projection
nodes:
  - id: inspect
    type: script
    command: node -e "console.log('approved')"
    capability: script
  - id: archive
    type: script
    command: node -e "console.log('archived')"
    capability: script
`)
    const facts = {
      ...world({ payload }).facts,
      terminalNodeStates: [
        {
          instanceId: 'inspect',
          status: 'done' as const,
          epoch: 2,
          attempt: 3,
          startedAtMs: 10,
          elapsedMs: 85,
          turns: 7
        },
        {
          instanceId: 'archive',
          status: 'skipped' as const,
          epoch: 1,
          attempt: 0,
          startedAtMs: 20,
          elapsedMs: 15,
          turns: 0
        }
      ]
    }
    const terminalLedger = emptyLedger([
      {
        eventId: 'terminal',
        watcherId: 'watcher-1',
        atMs: 100,
        origin: 'owner',
        class: 'fact',
        kind: 'terminal',
        state: 'pipeline-complete',
        reason: 'pipeline-complete'
      }
    ])
    const view = projectPipelineRunView({
      entry: watcherEntry('pipeline', payload, 'terminal'),
      ledger: terminalLedger,
      facts,
      nowMs: 100,
      unverifiableDispatchIds: new Set()
    })

    expect(
      view.nodes.map(({ nodeId, status, epoch, attempt, startedAtMs, elapsedMs, turns }) => ({
        nodeId,
        status,
        epoch,
        attempt,
        startedAtMs,
        elapsedMs,
        turns
      }))
    ).toEqual([
      {
        nodeId: 'inspect',
        status: 'done',
        epoch: 2,
        attempt: 3,
        startedAtMs: 10,
        elapsedMs: 85,
        turns: 7
      },
      {
        nodeId: 'archive',
        status: 'skipped',
        epoch: 1,
        attempt: 0,
        startedAtMs: 20,
        elapsedMs: 15,
        turns: 0
      }
    ])
  })

  it('shows unknown for compacted terminal nodes with no captured outcome rather than fabricating progress', () => {
    const payload = pipelinePayload(`version: 1
id: old-terminal-projection
name: Old terminal projection
nodes:
  - id: inspect
    type: script
    command: node -e "console.log('approved')"
    capability: script
`)
    const view = projectPipelineRunView({
      entry: watcherEntry('pipeline', payload, 'terminal'),
      ledger: emptyLedger([
        {
          eventId: 'terminal',
          watcherId: 'watcher-1',
          atMs: 100,
          origin: 'owner',
          class: 'fact',
          kind: 'terminal',
          state: 'pipeline-complete',
          reason: 'pipeline-complete'
        }
      ]),
      facts: world({ payload }).facts,
      nowMs: 100,
      unverifiableDispatchIds: new Set()
    })

    expect(view.nodes[0]).toMatchObject({
      nodeId: 'inspect',
      status: 'unknown',
      epoch: 0,
      attempt: 0
    })
  })

  it('shows unknown for a legacy terminal Loop without an after edge', () => {
    const payload = pipelinePayload(`version: 1
id: legacy-loop-terminal
name: Legacy Loop Terminal
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
    body: [planner, review]
    until: $review.outputs.verdict
    maxRounds: 1
`)
    const view = projectPipelineRunView({
      entry: watcherEntry('pipeline', payload, 'terminal'),
      ledger: emptyLedger([
        {
          eventId: 'terminal',
          watcherId: 'watcher-1',
          atMs: 100,
          origin: 'owner',
          class: 'fact',
          kind: 'terminal',
          state: 'pipeline-complete',
          reason: 'pipeline-complete'
        }
      ]),
      facts: world({ payload }).facts,
      nowMs: 100,
      unverifiableDispatchIds: new Set()
    })

    expect(view.nodes.find((node) => node.nodeId === 'iteration')).toMatchObject({
      nodeId: 'iteration',
      status: 'unknown',
      epoch: 0,
      attempt: 0
    })
  })

  it('renders an Objective copy from its persisted source snapshot and refuses missing or mismatched source', () => {
    const sourceText = `version: 1
id: objective-copy
name: Custom Objective
nodes:
  - id: finish
    type: objective
    label: Finish phase
    tier: standard
    landingBar: files-on-disk
`
    const parsed = parsePipelineText(sourceText)
    if (parsed.document === null) {
      throw new Error('Valid copied Objective source failed to parse')
    }
    const pin = {
      ref: 'objective-copy',
      scope: 'repo' as const,
      id: 'objective-copy',
      contentHash: pipelineContentHash(parsed.document),
      documentVersion: 1 as const
    }
    const facts = { ...world().facts, pin: { ...pin, runNumber: 12 } }
    const entry = watcherEntry('objective', OBJECTIVE_CONTRACT, 'implementation')
    const project = (pipelineSource?: { sourceText: string }) =>
      projectPipelineRunView({
        entry,
        ledger: emptyLedger(),
        facts,
        objectiveDetail: objectiveDetail(),
        ...(pipelineSource === undefined ? {} : { pipelineSource }),
        nowMs: 500,
        unverifiableDispatchIds: new Set()
      })
    const view = project({ sourceText })

    expect(view.pin).toMatchObject({
      ref: 'objective-copy',
      id: 'objective-copy',
      contentHash: pin.contentHash,
      runNumber: 12,
      label: 'Custom Objective v1'
    })
    expect(view.document).toMatchObject({
      id: 'objective-copy',
      name: 'Custom Objective',
      nodes: [{ id: 'finish', type: 'objective', label: 'Finish phase' }]
    })
    expect(view.nodes[0]).toMatchObject({
      instanceId: 'finish',
      nodeId: 'finish',
      label: 'Finish phase',
      type: 'objective'
    })
    expect(() => project()).toThrow('Pinned pipeline source snapshot is missing')
    expect(() =>
      project({ sourceText: sourceText.replace('Custom Objective', 'Edited on disk') })
    ).toThrow('Pinned pipeline source does not match its run pin')
  })

  it('renders a hosted-review copy using its pinned sitter source and node identity', () => {
    const sourceText = `version: 1
id: sitter-copy
name: Custom Sitter
nodes:
  - id: review
    type: pr-sitter
    label: Review changes
    repeatFixLimit: 4
`
    const parsed = parsePipelineText(sourceText)
    if (parsed.document === null) {
      throw new Error('Valid copied PR sitter source failed to parse')
    }
    const pin = {
      ref: 'user:sitter-copy',
      scope: 'user' as const,
      id: 'sitter-copy',
      contentHash: pipelineContentHash(parsed.document),
      documentVersion: 1 as const,
      runNumber: 3
    }
    const view = projectPipelineRunView({
      entry: watcherEntry('hosted-review', {}, 'watching'),
      ledger: emptyLedger(),
      facts: { ...world().facts, pin },
      pipelineSource: { sourceText },
      nowMs: 100,
      unverifiableDispatchIds: new Set()
    })

    expect(view.pin).toMatchObject({ ref: 'user:sitter-copy', label: 'Custom Sitter v1' })
    expect(view.document.nodes[0]).toMatchObject({
      id: 'review',
      label: 'Review changes',
      repeatFixLimit: 4
    })
    expect(view.nodes[0]).toMatchObject({
      nodeId: 'review',
      type: 'pr-sitter',
      label: 'Review changes',
      phase: 'watching'
    })
  })

  it('uses the live hosted-review phase and a stable built-in run label', () => {
    const view = projectPipelineRunView({
      entry: watcherEntry('hosted-review', {}, 'watching'),
      ledger: emptyLedger(),
      facts: { ...world().facts, pin: null },
      nowMs: 100,
      unverifiableDispatchIds: new Set()
    })

    expect(view.pin).toMatchObject({ ref: 'builtin:pr-sitter', label: 'PR sitter v1' })
    expect(view.nodes[0]).toMatchObject({
      nodeId: 'pr-sitter',
      phase: 'watching',
      label: 'PR sitter v1'
    })
  })
})
