import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { EnrollResult, WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import type {
  DispatchWorkerRequest,
  ExecuteContext,
  KernelAction,
  LeaseGuard
} from '../../shared/fork-heimdall/kind-contract'
import { buildPipelineAction } from '../../shared/fork-heimdall-pipeline/interpreter/action-envelope'
import { answerEvidence } from '../../shared/fork-heimdall-pipeline/interpreter-test-harness'
import { decidePipelineTick } from '../../shared/fork-heimdall-pipeline/interpreter/decide'
import { parsePipelineNodeEvidenceKey } from '../../shared/fork-heimdall-pipeline/choice-types'
import { pipelineNodeIdentity } from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import type { PipelineReadyWorld } from './pipeline-kind-read'
import { createPipelineActionDispatcher } from './pipeline-action-dispatch'
import type { PipelineActionDispatcher } from './pipeline-action-dispatch'
import {
  createPipelineKindTestHarness,
  type PipelineKindTestHarness
} from './pipeline-kind-test-harness'
import { createHostedReviewKind } from '../fork-hosted-review-sitter/kind'
import { createSitterCompositeAdapters } from './sitter-composite'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { resolveObjectiveWorkspaceTarget } from '../fork-heimdall-objective/workspace-target'
import { createObjectiveNodeCommit } from '../fork-heimdall-objective/merge-train-git'
import { readMergeSourceFacts } from './merge-executor'
import { prepareConflictResolution } from './pipeline-merge-git'
import { prepareChildWorktree } from './swarm-executor'
import { resolvePipelineChildTarget } from './pipeline-merge-source-reader'
import type { ObjectiveForgeAccess } from '../fork-heimdall-objective/objective-forge-access'

vi.mock('electron', () => ({}))

const RESOLVER_SOURCE = `version: 1
id: dispatcher-merge
name: Dispatcher Merge
nodes:
  - id: plan
    type: agent
    harness: claude
    prompt: Produce the task plan.
    outputs:
      tasks:
        type: taskList
  - id: swarm
    type: swarm
    after: [plan]
    from: $plan.outputs.tasks
    maxParallel: 1
    worktree: own
    child:
      harness: claude
      prompt: $task.spec
  - id: merge
    type: merge
    after: [swarm]
    from: swarm
`

const lease: LeaseGuard = {
  epoch: 1,
  holder: 'pipeline-action-dispatch-test',
  assertHeld: async () => undefined,
  renewLoop: () => ({ dispose: () => undefined })
}

const forge: ObjectiveForgeAccess = {
  detectProvider: async () => 'unsupported',
  getProvider: async () => null,
  getDefaultBranch: async () => null,
  isAuthenticated: async () => false,
  invalidate: () => undefined
}

const harnesses: PipelineKindTestHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()))
})

async function createHarness(): Promise<PipelineKindTestHarness> {
  const harness = await createPipelineKindTestHarness()
  harnesses.push(harness)
  return harness
}

function enrolled(result: EnrollResult) {
  if (result.status !== 'enrolled') {
    throw new Error(`Expected a pipeline enrollment, got ${JSON.stringify(result)}`)
  }
  return result.entry.enrollment
}

function readyWorld(
  harness: PipelineKindTestHarness,
  enrollment: ReturnType<typeof enrolled>,
  ledger: WatcherLedger = harness.service.ledger(enrollment.watcherId)
): PipelineReadyWorld {
  const payload = PipelineEnrollmentPayloadSchema.parse(enrollment.kindPayload)
  return {
    watcherId: enrollment.watcherId,
    enrollment,
    payload,
    facts: harness.pipelineStore.facts(enrollment.watcherId),
    ledger,
    nowMs: 30_000,
    hasOwner: enrollment.owner !== undefined,
    grants: enrollment.capabilities,
    workspacePath: enrollment.workspacePath,
    unverifiableDispatchIds: new Set(),
    composites: {},
    compositeReadErrors: {}
  }
}

function snapshot(world: PipelineReadyWorld) {
  return {
    freshness: 'live' as const,
    contentIdentity: `pipeline:${world.payload.pin.contentHash}`,
    observedAtMs: world.nowMs,
    world
  }
}

function dispatcherFor(harness: PipelineKindTestHarness) {
  const hostedReviewKind = createHostedReviewKind(harness.runtime, harness.store, 'desktop')
  const sitterAdapters = createSitterCompositeAdapters({
    runtime: harness.runtime,
    store: harness.store,
    pipelineStore: harness.pipelineStore,
    hostedReviewKind,
    storageAuthority: 'desktop'
  })
  return createPipelineActionDispatcher({
    runtime: harness.runtime,
    store: harness.store,
    pipelineStore: harness.pipelineStore,
    nowMs: () => 30_000,
    forge,
    compositeActions: sitterAdapters.compositeActions
  })
}
function preflightResolver(
  dispatcher: PipelineActionDispatcher,
  action: KernelAction,
  world: PipelineReadyWorld,
  ledger: WatcherLedger,
  enrollment: WatcherEnrollment
) {
  return dispatcher.preflight(action, snapshot(world), ledger, { enrollment })
}

function executionContext(world: PipelineReadyWorld): ExecuteContext<PipelineReadyWorld> {
  return {
    snapshot: snapshot(world),
    lease,
    ledger: world.ledger,
    dispatchWorker: async () => ({
      status: 'refused',
      reason: 'pre-dispatch-failure',
      detail: 'unused'
    })
  }
}

function attempt(
  action: KernelAction,
  watcherId: string,
  overrides: Partial<AttemptEntry> = {}
): AttemptEntry {
  return {
    eventId: `${action.kind}-attempt-event`,
    watcherId,
    atMs: 30_000,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: `${action.kind}-attempt`,
    fingerprint: makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey),
    action,
    state: 'running',
    ...overrides
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitExecFileAsync(args, { cwd, admissionTier: 'background' })).stdout.trim()
}
type ResolverFixture = Readonly<{
  harness: PipelineKindTestHarness
  enrollment: WatcherEnrollment
  world: PipelineReadyWorld
  ledger: WatcherLedger
  action: KernelAction
  childInstanceId: string
  childWorkspacePath: string
  childWorktreeId: string
  mergedHead: string
  normalizedCommitSha: string
}>

function appendLedger(ledger: WatcherLedger, ...entries: WatcherLedger['entries']): WatcherLedger {
  return { ...ledger, entries: [...ledger.entries, ...entries] }
}

async function createResolverFixture(runValue: 'run' | 'child' = 'run'): Promise<ResolverFixture> {
  const harness = await createHarness()
  const enrollment = enrolled(
    await harness.enroll(RESOLVER_SOURCE, { runInputs: { task: 'resolve test conflicts' } })
  )
  const payload = PipelineEnrollmentPayloadSchema.parse(enrollment.kindPayload)
  const childInstanceId = 'swarm[target]'
  const tasks = [
    { id: 'owner', title: 'Previously applied owner', spec: 'Create conflict.txt.' },
    { id: 'target', title: 'Target task', spec: 'Change conflict.txt.', deps: ['owner'] }
  ]
  const runBase = await git(harness.workspacePath, ['rev-parse', 'HEAD'])
  harness.pipelineStore.recordNodeOutput({
    watcherId: enrollment.watcherId,
    instanceId: 'plan',
    epoch: 0,
    attempt: 0,
    outputs: { tasks },
    reportSha256: null,
    nowMs: 1_000
  })
  harness.pipelineStore.recordSwarmExpansion({
    watcherId: enrollment.watcherId,
    swarmId: 'swarm',
    epoch: 0,
    tasks,
    warnings: [],
    baseCommit: runBase
  })
  const child = await prepareChildWorktree(
    {
      watcherId: enrollment.watcherId,
      instanceId: childInstanceId,
      epoch: 0,
      repoId: enrollment.repoId,
      baseCommit: runBase
    },
    { runtime: harness.runtime, store: harness.pipelineStore }
  )
  const childTarget = await resolvePipelineChildTarget({
    runtime: harness.runtime,
    enrollment,
    instanceId: childInstanceId,
    epoch: 0,
    worktreeId: child.worktreeId
  })
  const runTarget = await resolveObjectiveWorkspaceTarget(harness.runtime, enrollment)
  await writeFile(join(child.workspacePath, 'conflict.txt'), 'child\n')
  await writeFile(join(harness.workspacePath, 'conflict.txt'), 'run\n')
  await git(harness.workspacePath, ['add', 'conflict.txt'])
  await git(harness.workspacePath, ['commit', '-m', 'Previously applied owner task'])
  const conflictHead = await git(harness.workspacePath, ['rev-parse', 'HEAD'])
  const sourceBeforeNormalization = await readMergeSourceFacts(
    {
      watcherId: enrollment.watcherId,
      mergeId: 'merge',
      epoch: 0,
      childInstanceId,
      workspacePath: child.workspacePath,
      runWorkspacePath: runTarget.workspacePath,
      applicableBaseCommit: runBase
    },
    {
      store: harness.pipelineStore,
      resolveTarget: async (workspacePath) => {
        if (workspacePath !== childTarget.workspacePath) {
          throw new Error('Unexpected resolver fixture source')
        }
        return childTarget
      }
    }
  )
  const normalized = await createObjectiveNodeCommit(
    childTarget,
    {
      baseCommit: runBase,
      taskKey: 'target',
      title: 'Target task',
      reportedPaths: []
    },
    lease
  )
  if (runValue === 'child') {
    await writeFile(join(harness.workspacePath, 'conflict.txt'), 'child\n')
    await git(harness.workspacePath, ['add', 'conflict.txt'])
    await git(harness.workspacePath, ['commit', '-m', 'Clean retry merge base'])
  }
  const mergedHead = await git(harness.workspacePath, ['rev-parse', 'HEAD'])
  harness.pipelineStore.recordNodeOutput({
    watcherId: enrollment.watcherId,
    instanceId: 'swarm[owner]',
    epoch: 0,
    attempt: 0,
    outputs: {},
    reportSha256: null,
    nowMs: 1_500
  })
  harness.pipelineStore.setMergeProgress({
    watcherId: enrollment.watcherId,
    mergeId: 'merge',
    epoch: 0,
    childInstanceId: 'swarm[owner]',
    state: 'applied',
    commitSha: conflictHead,
    appliedCommitSha: conflictHead,
    conflict: null
  })
  harness.pipelineStore.recordNodeOutput({
    watcherId: enrollment.watcherId,
    instanceId: childInstanceId,
    epoch: 0,
    attempt: 0,
    outputs: {},
    reportSha256: null,
    nowMs: 2_000
  })
  harness.pipelineStore.recordDispatch({
    watcherId: enrollment.watcherId,
    instanceId: childInstanceId,
    epoch: 0,
    attempt: 0,
    dispatchId: 'target-agent-dispatch',
    workspaceId: child.worktreeId,
    terminalHandle: 'target-agent-terminal',
    reportPath: join(child.workspacePath, '.orca', 'target-report.json'),
    dispatchedAtMs: 2_000
  })
  const conflict = {
    paths: ['conflict.txt'],
    conflictingChildren: ['owner']
  }
  harness.pipelineStore.setMergeProgress({
    watcherId: enrollment.watcherId,
    mergeId: 'merge',
    epoch: 0,
    childInstanceId,
    state: 'conflict',
    commitSha: normalized.commitSha,
    conflict
  })
  const source = await readMergeSourceFacts(
    {
      watcherId: enrollment.watcherId,
      mergeId: 'merge',
      epoch: 0,
      childInstanceId,
      workspacePath: child.workspacePath,
      runWorkspacePath: runTarget.workspacePath,
      applicableBaseCommit: mergedHead,
      childCommitSha: normalized.commitSha
    },
    {
      store: harness.pipelineStore,
      resolveTarget: async (workspacePath) => {
        if (workspacePath !== childTarget.workspacePath) {
          throw new Error('Unexpected resolver fixture source')
        }
        return childTarget
      }
    }
  )
  const planAction = buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'external',
    pin: payload.pin,
    instanceId: 'plan',
    nodeId: 'plan',
    epoch: 0,
    attempt: 0,
    fields: { agent: 'claude', spec: 'Produce a task plan.' }
  })
  const workerAction = buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'external',
    pin: payload.pin,
    instanceId: childInstanceId,
    nodeId: 'swarm',
    epoch: 0,
    attempt: 0,
    fields: { agent: 'claude', spec: 'Change conflict.txt.' }
  })
  const ownerAction = buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'external',
    pin: payload.pin,
    instanceId: 'swarm[owner]',
    nodeId: 'swarm',
    epoch: 0,
    attempt: 0,
    fields: { agent: 'claude', spec: 'Create conflict.txt.' }
  })
  const originalChildCommitSha = sourceBeforeNormalization.committedChildSha
  const originalSourceIdentity =
    originalChildCommitSha === null
      ? [
          'worktree',
          sourceBeforeNormalization.sourceHead,
          sourceBeforeNormalization.workspaceDigest
        ]
      : ['commit', originalChildCommitSha]
  const integrationAction = buildPipelineAction({
    kind: 'pipeline-merge-child',
    capability: 'integrate',
    visibility: 'local',
    pin: payload.pin,
    instanceId: 'merge',
    nodeId: 'merge',
    epoch: 0,
    attempt: 0,
    step: JSON.stringify([childInstanceId, originalSourceIdentity, runBase]),
    fields: {
      mergeId: 'merge',
      childInstanceId,
      taskId: 'target',
      childWorkspacePath: child.workspacePath,
      sourceHead: sourceBeforeNormalization.sourceHead,
      workspaceDigest: sourceBeforeNormalization.workspaceDigest,
      baseCommit: runBase,
      childCommitSha: originalChildCommitSha,
      unmergedPaths: [],
      appliedChildren: [{ taskId: 'owner', commitSha: conflictHead }]
    }
  })
  const baseLedger = harness.service.ledger(enrollment.watcherId)
  const ledger = appendLedger(
    baseLedger,
    attempt(planAction, enrollment.watcherId, {
      eventId: 'resolver-plan-attempt',
      attemptId: 'resolver-plan-attempt-id',
      atMs: 1_000,
      state: 'settled',
      effect: 'landed'
    }),
    attempt(ownerAction, enrollment.watcherId, {
      eventId: 'resolver-owner-attempt',
      attemptId: 'resolver-owner-attempt-id',
      atMs: 1_500,
      state: 'settled',
      effect: 'landed'
    }),
    attempt(workerAction, enrollment.watcherId, {
      eventId: 'resolver-child-attempt',
      attemptId: 'resolver-child-attempt-id',
      atMs: 2_000,
      state: 'settled',
      effect: 'landed',
      dispatchId: 'target-agent-dispatch'
    }),
    attempt(integrationAction, enrollment.watcherId, {
      eventId: 'resolver-integration-attempt',
      attemptId: 'resolver-integration-attempt-id',
      atMs: 3_000,
      state: 'settled',
      effect: 'not-landed',
      failureClass: 'criteria',
      reason: 'merge-conflict',
      result: { conflictPaths: conflict.paths, conflictingChildren: conflict.conflictingChildren }
    })
  )
  const baseWorld = readyWorld(harness, enrollment, ledger)
  const world = { ...baseWorld, mergeSources: { [childInstanceId]: source } }
  const decision = decidePipelineTick(world, ledger)
  if (decision.action?.kind !== 'pipeline-resolve-merge-conflict') {
    throw new Error(
      `Expected a conflict resolver action, got ${decision.action?.kind ?? 'no action'}`
    )
  }
  return {
    harness,
    enrollment,
    world,
    ledger,
    action: decision.action,
    childInstanceId,
    childWorkspacePath: child.workspacePath,
    mergedHead,
    childWorktreeId: child.worktreeId,
    normalizedCommitSha: normalized.commitSha
  }
}

async function refreshedResolverWorld(
  fixture: ResolverFixture,
  ledger: WatcherLedger
): Promise<PipelineReadyWorld> {
  const facts = fixture.harness.pipelineStore.facts(fixture.enrollment.watcherId)
  let progress: PipelineStoreFacts['mergeProgress'][number] | null = null
  for (const candidate of facts.mergeProgress) {
    if (
      candidate.mergeId === 'merge' &&
      candidate.childInstanceId === fixture.childInstanceId &&
      (progress === null || candidate.epoch >= progress.epoch)
    ) {
      progress = candidate
    }
  }
  if (progress === null || progress.commitSha === null) {
    throw new Error('Missing recorded resolver progress')
  }
  const runTarget = await resolveObjectiveWorkspaceTarget(
    fixture.harness.runtime,
    fixture.enrollment
  )
  const childTarget = await resolvePipelineChildTarget({
    runtime: fixture.harness.runtime,
    enrollment: fixture.enrollment,
    instanceId: fixture.childInstanceId,
    epoch: 0,
    worktreeId: fixture.childWorktreeId
  })
  const mergedHead = await git(runTarget.workspacePath, ['rev-parse', 'HEAD'])
  const source = await readMergeSourceFacts(
    {
      watcherId: fixture.enrollment.watcherId,
      mergeId: 'merge',
      epoch: progress.epoch,
      childInstanceId: fixture.childInstanceId,
      workspacePath: childTarget.workspacePath,
      runWorkspacePath: runTarget.workspacePath,
      applicableBaseCommit: mergedHead,
      childCommitSha: progress.commitSha
    },
    {
      store: fixture.harness.pipelineStore,
      resolveTarget: async (workspacePath) => {
        if (workspacePath !== childTarget.workspacePath) {
          throw new Error('Unexpected refreshed resolver source')
        }
        return childTarget
      }
    }
  )
  return {
    ...readyWorld(fixture.harness, fixture.enrollment, ledger),
    mergeSources: { [fixture.childInstanceId]: source }
  }
}
type RetriedResolverFixture = Readonly<{
  action: KernelAction
  world: PipelineReadyWorld
  ledger: WatcherLedger
}>

async function createRetriedResolverFixture(
  fixture: ResolverFixture
): Promise<RetriedResolverFixture> {
  const failedLedger = appendLedger(
    fixture.ledger,
    attempt(fixture.action, fixture.enrollment.watcherId, {
      eventId: 'failed-resolver-attempt',
      attemptId: 'failed-resolver-attempt-id',
      atMs: 4_000,
      state: 'settled',
      effect: 'not-landed',
      failureClass: 'criteria',
      reason: 'resolver-left-conflicts'
    })
  )
  const choice = decidePipelineTick(fixture.world, failedLedger).action
  if (choice?.kind !== 'pipeline-apply-choice') {
    throw new Error('Expected a Merge conflict retry choice')
  }
  const answer = answerEvidence(
    {
      actionKind: choice.kind,
      contentIdentity: choice.contentIdentity,
      evidenceKey: choice.evidenceKey
    },
    'retry'
  )
  const answeredLedger = appendLedger(failedLedger, {
    ...answer,
    eventId: 'merge-retry-answer',
    watcherId: fixture.enrollment.watcherId,
    atMs: 4_500
  })
  const retryControl = decidePipelineTick(fixture.world, answeredLedger).action
  if (retryControl?.kind !== 'pipeline-apply-choice') {
    throw new Error('Expected the landed retry control')
  }
  const ledger = appendLedger(
    answeredLedger,
    attempt(retryControl, fixture.enrollment.watcherId, {
      eventId: 'landed-merge-retry',
      attemptId: 'landed-merge-retry-id',
      atMs: 5_000,
      state: 'settled',
      effect: 'landed'
    })
  )
  const previousRows = fixture.harness.pipelineStore
    .facts(fixture.enrollment.watcherId)
    .mergeProgress.filter((candidate) => candidate.mergeId === 'merge' && candidate.epoch === 0)
  for (const row of previousRows) {
    fixture.harness.pipelineStore.setMergeProgress({
      watcherId: fixture.enrollment.watcherId,
      mergeId: row.mergeId,
      epoch: 1,
      childInstanceId: row.childInstanceId,
      state: row.childInstanceId === fixture.childInstanceId ? 'conflict' : row.state,
      commitSha: row.commitSha,
      appliedCommitSha: row.appliedCommitSha,
      conflict: row.conflict
    })
  }
  const world = await refreshedResolverWorld(fixture, ledger)
  const action = decidePipelineTick(world, ledger).action
  if (action?.kind !== 'pipeline-resolve-merge-conflict') {
    throw new Error('Expected a resolver for the retried Merge epoch')
  }
  return { action, world, ledger }
}

function changedResolverAction(
  action: KernelAction,
  stepIndex: number,
  field: string,
  value: unknown,
  pin: PipelineReadyWorld['payload']['pin']
): KernelAction {
  const identity = pipelineNodeIdentity(action)
  const decoded = parsePipelineNodeEvidenceKey(action.evidenceKey)
  if (identity === null || decoded?.step === undefined) {
    throw new Error('Resolver action evidence is malformed')
  }
  const parsed: unknown = JSON.parse(decoded.step)
  if (!Array.isArray(parsed)) {
    throw new Error('Resolver step must be an array')
  }
  const step = [...parsed]
  step[stepIndex] = value
  return buildPipelineAction({
    kind: action.kind,
    capability: action.capability,
    visibility: action.visibility,
    pin,
    instanceId: identity.instanceId,
    nodeId: identity.nodeId,
    epoch: identity.epoch,
    attempt: identity.attempt,
    step: JSON.stringify(step),
    fields: { ...action, [field]: value }
  })
}

describe('pipeline action dispatcher', () => {
  it('binds resolver preflight to the real clean child source, target task, worker and original attempt', async () => {
    const fixture = await createResolverFixture()
    const dispatcher = dispatcherFor(fixture.harness)

    await expect(
      preflightResolver(
        dispatcher,
        fixture.action,
        fixture.world,
        fixture.ledger,
        fixture.enrollment
      )
    ).resolves.toEqual({ verdict: 'allow' })

    const wrongOwner = changedResolverAction(
      fixture.action,
      17,
      'conflictingChildren',
      [fixture.childInstanceId],
      fixture.world.payload.pin
    )
    await expect(
      preflightResolver(dispatcher, wrongOwner, fixture.world, fixture.ledger, fixture.enrollment)
    ).resolves.toMatchObject({ verdict: 'hold' })

    const wrongWorker = changedResolverAction(
      fixture.action,
      19,
      'harness',
      'codex',
      fixture.world.payload.pin
    )
    await expect(
      preflightResolver(dispatcher, wrongWorker, fixture.world, fixture.ledger, fixture.enrollment)
    ).resolves.toMatchObject({ verdict: 'hold' })

    const wrongOriginalAttempt = changedResolverAction(
      fixture.action,
      5,
      'originalMergeAttemptId',
      'unrelated-integration-attempt',
      fixture.world.payload.pin
    )
    await expect(
      preflightResolver(
        dispatcher,
        wrongOriginalAttempt,
        fixture.world,
        fixture.ledger,
        fixture.enrollment
      )
    ).resolves.toMatchObject({ verdict: 'hold' })

    const source = fixture.world.mergeSources?.[fixture.childInstanceId]
    if (source === undefined) {
      throw new Error('Missing resolver source snapshot')
    }
    const staleWorld = {
      ...fixture.world,
      mergeSources: {
        ...fixture.world.mergeSources,
        [fixture.childInstanceId]: {
          ...source,
          workspaceDigest: '0'.repeat(64),
          applicableBaseCommit: 'f'.repeat(40)
        }
      }
    }
    await expect(
      preflightResolver(dispatcher, fixture.action, staleWorld, fixture.ledger, fixture.enrollment)
    ).resolves.toMatchObject({ verdict: 'hold' })

    const missingCapabilities = {
      ...fixture.world,
      grants: { ...fixture.world.grants, agent: 'off' as const, integrate: 'off' as const }
    }
    await expect(
      preflightResolver(
        dispatcher,
        fixture.action,
        missingCapabilities,
        fixture.ledger,
        fixture.enrollment
      )
    ).resolves.toMatchObject({ verdict: 'hold' })
  })

  it('recovers an existing resolver cherry-pick without resetting and dispatches only after conflict proof', async () => {
    const fixture = await createResolverFixture()
    const dispatcher = dispatcherFor(fixture.harness)

    const refuseDispatch = vi.fn(
      async (_request: DispatchWorkerRequest) =>
        ({
          status: 'refused',
          reason: 'pre-dispatch-failure',
          detail: 'test refusal'
        }) as const
    )
    await dispatcher.execute(fixture.action, {
      ...executionContext(fixture.world),
      dispatchWorker: refuseDispatch
    })

    expect(refuseDispatch).toHaveBeenCalledTimes(1)
    const progress = fixture.harness.pipelineStore
      .facts(fixture.enrollment.watcherId)
      .mergeProgress.find((candidate) => candidate.childInstanceId === fixture.childInstanceId)
    expect(progress).toMatchObject({ state: 'resolving', commitSha: fixture.normalizedCommitSha })
    const preparedHead = await git(fixture.childWorkspacePath, ['rev-parse', 'HEAD'])
    const cherryPickHead = await git(fixture.childWorkspacePath, ['rev-parse', 'CHERRY_PICK_HEAD'])
    expect(preparedHead).toBe(fixture.mergedHead)
    expect(cherryPickHead).toBe(fixture.normalizedCommitSha)
    expect(await git(fixture.childWorkspacePath, ['diff', '--name-only', '--diff-filter=U'])).toBe(
      'conflict.txt'
    )

    const retried = await createRetriedResolverFixture(fixture)
    expect(pipelineNodeIdentity(retried.action)?.epoch).toBe(1)
    expect(retried.action.originalMergeEpoch).toBe(0)
    expect(retried.action.originalMergeAttemptId).toBe('resolver-integration-attempt-id')
    await expect(
      preflightResolver(
        dispatcher,
        retried.action,
        retried.world,
        retried.ledger,
        fixture.enrollment
      )
    ).resolves.toEqual({ verdict: 'allow' })
    const recoverDispatch = vi.fn(
      async (_request: DispatchWorkerRequest) =>
        ({
          status: 'refused',
          reason: 'pre-dispatch-failure',
          detail: 'recovery refusal'
        }) as const
    )
    await dispatcher.execute(retried.action, {
      ...executionContext(retried.world),
      dispatchWorker: recoverDispatch
    })

    expect(recoverDispatch).toHaveBeenCalledTimes(1)
    expect(await git(fixture.childWorkspacePath, ['rev-parse', 'HEAD'])).toBe(preparedHead)
    expect(await git(fixture.childWorkspacePath, ['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(
      cherryPickHead
    )
    expect(await git(fixture.childWorkspacePath, ['diff', '--name-only', '--diff-filter=U'])).toBe(
      'conflict.txt'
    )
  })

  it('recovers a cleanly prepared resolving child without replaying its normalized commit', async () => {
    const fixture = await createResolverFixture('child')
    const target = await resolvePipelineChildTarget({
      runtime: fixture.harness.runtime,
      enrollment: fixture.enrollment,
      instanceId: fixture.childInstanceId,
      epoch: 0,
      worktreeId: fixture.childWorktreeId
    })
    await prepareConflictResolution(
      {
        childWorkspacePath: target.workspacePath,
        mergedHead: fixture.mergedHead,
        childCommitSha: fixture.normalizedCommitSha
      },
      {
        lease,
        resolveTarget: async (workspacePath) => {
          if (workspacePath !== target.workspacePath) {
            throw new Error('Unexpected prepared resolver target')
          }
          return target
        }
      }
    )
    const preparedHead = await git(target.workspacePath, ['rev-parse', 'HEAD'])
    const retried = await createRetriedResolverFixture(fixture)
    const progress = fixture.harness.pipelineStore
      .facts(fixture.enrollment.watcherId)
      .mergeProgress.find(
        (candidate) =>
          candidate.childInstanceId === fixture.childInstanceId && candidate.epoch === 1
      )
    if (progress === undefined || progress.conflict === null) {
      throw new Error('Expected retry conflict progress before clean recovery')
    }
    fixture.harness.pipelineStore.setMergeProgress({
      watcherId: fixture.enrollment.watcherId,
      mergeId: 'merge',
      epoch: 1,
      childInstanceId: fixture.childInstanceId,
      state: 'resolving',
      commitSha: progress.commitSha,
      conflict: progress.conflict
    })
    const world = await refreshedResolverWorld(fixture, retried.ledger)
    const dispatchWorker = vi.fn(
      async (_request: DispatchWorkerRequest) =>
        ({
          status: 'refused',
          reason: 'pre-dispatch-failure',
          detail: 'must not dispatch'
        }) as const
    )

    const outcome = await dispatcherFor(fixture.harness).execute(retried.action, {
      ...executionContext(world),
      dispatchWorker
    })

    expect(outcome).toMatchObject({ effect: 'landed' })
    expect(dispatchWorker).not.toHaveBeenCalled()
    expect(await git(target.workspacePath, ['rev-parse', 'HEAD'])).toBe(preparedHead)
    const after = fixture.harness.pipelineStore.facts(fixture.enrollment.watcherId).mergeProgress
    expect(
      after.find(
        (candidate) =>
          candidate.childInstanceId === fixture.childInstanceId && candidate.epoch === 1
      )
    ).toMatchObject({
      state: 'resolved',
      commitSha: fixture.normalizedCommitSha,
      conflict: null
    })
    expect(
      after.find(
        (candidate) => candidate.childInstanceId === 'swarm[owner]' && candidate.epoch === 1
      )
    ).toMatchObject({
      state: 'applied'
    })
  })
})
