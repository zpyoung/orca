import { describe, expect, it, vi } from 'vitest'
import type { AttemptEntry, KernelAction } from '../../shared/fork-heimdall/ledger-types'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { PipelineEnrollmentPayload } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import type { PipelineStore } from './pipeline-store'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  answerEvidence,
  attemptEntry,
  emptyLedger,
  pipelinePayload,
  world
} from '../../shared/fork-heimdall-pipeline/interpreter-test-harness'
import { buildPipelineAction } from '../../shared/fork-heimdall-pipeline/interpreter/action-envelope'
import { nodeIdFromInstanceId } from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import type { PipelineReadyWorld } from './pipeline-kind-read'
import { createInMemoryPipelineStore } from './pipeline-store-test-fixtures'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ResolvedWorktree } from '../runtime/runtime-worktree-path-identity'
import { pipelineChildWorktreeMarker } from './swarm-executor'
import { createPipelineConcurrencyPolicy } from './pipeline-concurrency-policy'

function createRuntime(): OrcaRuntimeService {
  return new OrcaRuntimeService()
}

const PIPELINE_YAML = (worktree: 'own' | 'shared') => `version: 1
id: concurrency
name: Concurrency
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
    maxParallel: 2
    worktree: ${worktree}
    child:
      harness: codex
      prompt: $task.spec
  - id: merge
    type: merge
    after: [swarm]
    from: swarm
`

function lease(assertHeld: LeaseGuard['assertHeld']): LeaseGuard {
  return {
    epoch: 1,
    holder: 'test-holder',
    assertHeld,
    renewLoop: () => ({ dispose: () => {} })
  }
}

function enrollment(kindPayload: unknown, terminalAtMs: number | null = null): WatcherEnrollment {
  return {
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
    capabilities: { agent: 'on', integrate: 'on' },
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload,
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs
  }
}

function readyWorld(worktree: 'own' | 'shared' = 'shared'): PipelineReadyWorld {
  const payload = pipelinePayload(PIPELINE_YAML(worktree))
  return {
    ...world({ payload }),
    enrollment: enrollment(payload),
    ledger: emptyLedger()
  }
}

function snapshot(world: PipelineReadyWorld): Snapshot<PipelineReadyWorld> {
  return { freshness: 'live', contentIdentity: 'pipeline:content', observedAtMs: 1, world }
}

function action(
  kind: string,
  instanceId: string,
  options: {
    nodeId?: string
    payload?: PipelineEnrollmentPayload
    fields?: Record<string, unknown>
    epoch?: number
    attempt?: number
  } = {}
): KernelAction {
  const payload = options.payload ?? pipelinePayload(PIPELINE_YAML('shared'))
  return buildPipelineAction({
    kind,
    capability: kind === 'pipeline-merge-child' ? 'integrate' : 'agent',
    visibility: 'local',
    pin: payload.pin,
    instanceId,
    nodeId: options.nodeId ?? nodeIdFromInstanceId(instanceId),
    epoch: options.epoch ?? 0,
    attempt: options.attempt ?? 0,
    fields: options.fields
  })
}

function childAttempt(
  kind: 'pipeline-dispatch-agent' | 'pipeline-resolve-merge-conflict' = 'pipeline-dispatch-agent',
  taskId = 'task-a'
): AttemptEntry {
  const childInstanceId = `swarm[${taskId}]`
  const childAction = action(
    kind,
    kind === 'pipeline-dispatch-agent' ? childInstanceId : `merge[${taskId}]`,
    {
      payload: pipelinePayload(PIPELINE_YAML('own')),
      nodeId: kind === 'pipeline-dispatch-agent' ? 'swarm' : 'merge',
      fields: kind === 'pipeline-resolve-merge-conflict' ? { childInstanceId } : undefined,
      epoch: kind === 'pipeline-resolve-merge-conflict' ? 3 : 1
    }
  )
  return attemptEntry(childAction, 'settled', 1_000, {
    attemptId: `${kind}:${taskId}`,
    effect: 'landed',
    dispatchId: `dispatch:${taskId}`
  })
}

function recordSwarmExpansion(store: PipelineStore): void {
  store.recordSwarmExpansion({
    watcherId: 'watcher-1',
    swarmId: 'swarm',
    epoch: 0,
    tasks: [
      { id: 'task-a', title: 'Task A', spec: 'Implement task A' },
      { id: 'task-b', title: 'Task B', spec: 'Implement task B' }
    ],
    warnings: [],
    baseCommit: 'base'
  })
}

function recordMergeProgress(
  store: PipelineStore,
  state: 'pending' | 'applied' | 'conflict' | 'resolved' | 'resolving' | 'skipped',
  epoch = 0
): void {
  store.setMergeProgress({
    watcherId: 'watcher-1',
    mergeId: 'merge',
    epoch,
    childInstanceId: 'swarm[task-a]',
    state,
    commitSha: null,
    appliedCommitSha: null
  })
}

describe('pipeline concurrency overlap policy', () => {
  const exclusiveKinds = [
    'pipeline-merge-child',
    'pipeline-land-commit',
    'pipeline-land-push',
    'pipeline-land-open-review',
    'pipeline-run-check',
    'pipeline-run-script'
  ]

  it('allows different shared Agents to overlap but serializes them against exclusive mutations', () => {
    const shared = readyWorld('shared')
    const policy = createPipelineConcurrencyPolicy({
      runtime: createRuntime(),
      pipelineStore: createInMemoryPipelineStore()
    })
    const firstAgent = action('pipeline-dispatch-agent', 'swarm[task-a]', {
      payload: shared.payload,
      nodeId: 'swarm'
    })
    const secondAgent = action('pipeline-dispatch-agent', 'swarm[task-b]', {
      payload: shared.payload,
      nodeId: 'swarm'
    })

    expect(policy.canRunAlongside(firstAgent, [secondAgent], snapshot(shared), emptyLedger())).toBe(
      true
    )
    expect(policy.canRunAlongside(firstAgent, [firstAgent], snapshot(shared), emptyLedger())).toBe(
      false
    )

    for (const [index, kind] of exclusiveKinds.entries()) {
      const mutation = action(kind, `mutation-${index}`, {
        payload: shared.payload,
        nodeId: `mutation-${index}`
      })
      expect(policy.canRunAlongside(mutation, [firstAgent], snapshot(shared), emptyLedger())).toBe(
        false
      )
      expect(policy.canRunAlongside(firstAgent, [mutation], snapshot(shared), emptyLedger())).toBe(
        false
      )
      const otherMutation = action(kind, `other-mutation-${index}`, {
        payload: shared.payload,
        nodeId: `other-mutation-${index}`
      })
      expect(
        policy.canRunAlongside(mutation, [otherMutation], snapshot(shared), emptyLedger())
      ).toBe(false)
    }
  })

  it('lets an own-worktree child overlap any different instance in either direction', () => {
    const own = readyWorld('own')
    const policy = createPipelineConcurrencyPolicy({
      runtime: createRuntime(),
      pipelineStore: createInMemoryPipelineStore()
    })
    const child = action('pipeline-dispatch-agent', 'swarm[task-a]', {
      payload: own.payload,
      nodeId: 'swarm'
    })
    for (const kind of [...exclusiveKinds, 'pipeline-dispatch-agent']) {
      const other = action(kind, `other-${kind}`, { payload: own.payload, nodeId: `other-${kind}` })
      expect(policy.canRunAlongside(child, [other], snapshot(own), emptyLedger())).toBe(true)
      expect(policy.canRunAlongside(other, [child], snapshot(own), emptyLedger())).toBe(true)
    }
    expect(
      policy.preserveAttemptOnContentChange(childAttempt(), snapshot(own), emptyLedger())
    ).toBe(true)
    const sharedAction = action('pipeline-dispatch-agent', 'plan', {
      payload: own.payload,
      nodeId: 'plan'
    })
    expect(
      policy.preserveAttemptOnContentChange(
        attemptEntry(sharedAction),
        snapshot(own),
        emptyLedger()
      )
    ).toBe(false)
  })
})

describe('pipeline concurrency isolation policy', () => {
  it('requires a ready persisted child worktree for dispatches and resolvers, with no fallback', () => {
    const store = createInMemoryPipelineStore()
    const policy = createPipelineConcurrencyPolicy({
      runtime: createRuntime(),
      pipelineStore: store
    })
    const dispatch = childAttempt()
    const resolver = childAttempt('pipeline-resolve-merge-conflict')

    expect(policy.isIsolatedAttempt(dispatch, emptyLedger())).toBe(false)
    recordSwarmExpansion(store)
    store.recordChildWorktree({
      watcherId: 'watcher-1',
      instanceId: 'swarm[task-a]',
      epoch: 1,
      worktreeId: 'worktree-task-a',
      setupState: 'setting-up'
    })
    expect(policy.isIsolatedAttempt(dispatch, emptyLedger())).toBe(false)
    store.recordChildWorktree({
      watcherId: 'watcher-1',
      instanceId: 'swarm[task-a]',
      epoch: 1,
      worktreeId: 'worktree-task-a',
      setupState: 'ready'
    })
    expect(policy.isIsolatedAttempt(dispatch, emptyLedger())).toBe(true)
    expect(policy.isIsolatedAttempt(resolver, emptyLedger())).toBe(true)

    store.recordChildWorktree({
      watcherId: 'watcher-1',
      instanceId: 'swarm[task-a]',
      epoch: 2,
      worktreeId: 'worktree-task-a-next',
      setupState: 'removed'
    })
    expect(policy.isIsolatedAttempt(resolver, emptyLedger())).toBe(false)
    const unscopedAction = action('pipeline-dispatch-agent', 'plan')
    expect(policy.isIsolatedAttempt(attemptEntry(unscopedAction), emptyLedger())).toBe(false)
  })
})

describe('pipeline Swarm worker retention', () => {
  it('retains a Swarm child until Merge progress is applied or skipped', () => {
    const store = createInMemoryPipelineStore()
    const attempt = childAttempt()
    const mergeAction = action('pipeline-merge-child', 'merge', {
      fields: { mergeId: 'merge', childInstanceId: 'swarm[task-a]' },
      nodeId: 'merge'
    })
    const ledger = emptyLedger([
      attemptEntry(mergeAction, 'settled', 1_001, {
        attemptId: 'merge-attempt',
        effect: 'not-landed'
      })
    ])
    const policy = createPipelineConcurrencyPolicy({
      runtime: createRuntime(),
      pipelineStore: store
    })

    expect(policy.retainWorker(attempt, emptyLedger())).toBe(true)
    recordSwarmExpansion(store)
    expect(policy.retainWorker(attempt, ledger)).toBe(true)
    recordMergeProgress(store, 'conflict', 0)
    expect(policy.retainWorker(attempt, ledger)).toBe(true)
    recordMergeProgress(store, 'applied', 0)
    expect(policy.retainWorker(attempt, ledger)).toBe(false)

    recordMergeProgress(store, 'applied', 0)
    recordMergeProgress(store, 'pending', 1)
    expect(policy.retainWorker(attempt, ledger)).toBe(true)
    recordMergeProgress(store, 'skipped', 1)
    expect(policy.retainWorker(attempt, ledger)).toBe(false)
  })

  it('releases only the exact child targeted by a landed Merge-conflict Skip', () => {
    const store = createInMemoryPipelineStore()
    recordSwarmExpansion(store)
    const unrelatedChild = childAttempt('pipeline-dispatch-agent', 'task-a')
    const targetedChild = childAttempt('pipeline-dispatch-agent', 'task-b')
    const skipAction = action('pipeline-apply-choice', 'merge', {
      nodeId: 'merge',
      fields: {
        cause: 'merge-conflict',
        choice: 'skip',
        conflictingChildren: ['task-a'],
        conflictingChildInstanceId: 'swarm[task-b]'
      }
    })
    const scope = {
      actionKind: skipAction.kind,
      contentIdentity: skipAction.contentIdentity,
      evidenceKey: skipAction.evidenceKey
    }
    const ledger = emptyLedger([
      unrelatedChild,
      targetedChild,
      answerEvidence(scope, 'skip'),
      attemptEntry(skipAction, 'settled', 1_003, { attemptId: 'skip-landed', effect: 'landed' })
    ])
    const policy = createPipelineConcurrencyPolicy({
      runtime: createRuntime(),
      pipelineStore: store
    })

    expect(policy.retainWorker(unrelatedChild, ledger)).toBe(true)
    expect(policy.retainWorker(targetedChild, ledger)).toBe(false)
  })
})

describe('pipeline concurrency budget and reconciliation', () => {
  it('never drains or admits work after budget exhaustion', () => {
    const runWorld = readyWorld()
    const policy = createPipelineConcurrencyPolicy({
      runtime: createRuntime(),
      pipelineStore: createInMemoryPipelineStore()
    })
    const candidate = action('pipeline-dispatch-agent', 'plan', {
      payload: runWorld.payload,
      nodeId: 'plan'
    })

    expect(policy.shouldDrainBudget(snapshot(runWorld), emptyLedger())).toBe(false)
    expect(policy.canRunWhenBudgetExhausted(candidate, snapshot(runWorld), emptyLedger())).toBe(
      false
    )
  })

  it('reconciles both native identity and fingerprint keys while holding the lease', async () => {
    const store = createInMemoryPipelineStore()
    const runWorld = readyWorld()
    const nativeAction = action('pipeline-dispatch-agent', 'swarm[task-a]', {
      payload: runWorld.payload,
      nodeId: 'swarm',
      epoch: 2,
      attempt: 3
    })
    const nativeAttempt = attemptEntry(nativeAction, 'running', 1_000, {
      attemptId: 'native-attempt',
      dispatchId: 'dispatch-native'
    })
    const fingerprintOnlyAction: KernelAction = {
      kind: 'generic-action',
      capability: 'agent',
      visibility: 'local',
      contentIdentity: 'generic-content',
      evidenceKey: 'generic-key'
    }
    const fingerprintAttempt = attemptEntry(fingerprintOnlyAction, 'settled', 1_001, {
      attemptId: 'fingerprint-attempt',
      effect: 'landed'
    })
    for (const [instanceId, epoch, attempt, dispatchId] of [
      ['swarm[task-a]', 2, 3, 'dispatch-native'],
      ['orphan', 9, 1, 'dispatch-orphan']
    ] as const) {
      store.recordDispatch({
        watcherId: 'watcher-1',
        instanceId,
        epoch,
        attempt,
        dispatchId,
        workspaceId: null,
        terminalHandle: null,
        reportPath: '/workspace/report.json',
        dispatchedAtMs: 1
      })
    }
    store.recordAttemptBaseline({
      watcherId: 'watcher-1',
      attemptFingerprint: nativeAttempt.fingerprint,
      workspacePath: '/workspace/native',
      digest: { retained: true }
    })
    store.recordAttemptBaseline({
      watcherId: 'watcher-1',
      attemptFingerprint: fingerprintAttempt.fingerprint,
      workspacePath: '/workspace/fingerprint',
      digest: { retained: true }
    })
    store.recordAttemptBaseline({
      watcherId: 'watcher-1',
      attemptFingerprint: 'orphan-fingerprint',
      workspacePath: '/workspace/orphan',
      digest: { retained: false }
    })
    const assertHeld = vi.fn(async () => {})
    const policy = createPipelineConcurrencyPolicy({
      runtime: createRuntime(),
      pipelineStore: store
    })

    await policy.reconcile!(snapshot(runWorld), emptyLedger([nativeAttempt, fingerprintAttempt]), {
      enrollment: enrollment(runWorld.payload),
      lease: lease(assertHeld),
      stopWorker: async () => ({ status: 'applied', appliedAtMs: 1 }),
      workerReleaseConfirmed: () => true
    })

    expect(store.facts('watcher-1').dispatches.map((dispatch) => dispatch.dispatchId)).toEqual([
      'dispatch-native'
    ])
    expect(store.attemptBaseline('watcher-1', nativeAttempt.fingerprint)).not.toBeNull()
    expect(store.attemptBaseline('watcher-1', fingerprintAttempt.fingerprint)).not.toBeNull()
    expect(store.attemptBaseline('watcher-1', 'orphan-fingerprint')).toBeNull()
    expect(assertHeld).toHaveBeenCalledTimes(2)
  })
})

describe('pipeline child worktree cleanup', () => {
  function runtimeFor(worktreeComment: string): OrcaRuntimeService {
    const runtime = createRuntime()
    const worktree = {
      id: 'worktree-cleanup',
      repoId: 'repo-1',
      path: '/workspace/child',
      head: 'abc',
      branch: 'main',
      isBare: false,
      isMainWorktree: false,
      displayName: 'Pipeline child',
      comment: worktreeComment,
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: '/workspace/child',
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: false
      }
    } satisfies ResolvedWorktree
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue(worktree)
    vi.spyOn(runtime, 'removeManagedWorktree').mockResolvedValue({})
    return runtime
  }

  function cleanupContext(terminalAtMs: number | null, assertHeld: () => Promise<void>) {
    return {
      enrollment: enrollment(pipelinePayload(PIPELINE_YAML('own')), terminalAtMs),
      lease: lease(assertHeld),
      workerReleaseConfirmed: () => true
    }
  }

  it('returns true only when a prior child worktree transitions to removed', async () => {
    const store = createInMemoryPipelineStore()
    store.recordChildWorktree({
      watcherId: 'watcher-1',
      instanceId: 'swarm[task-a]',
      epoch: 0,
      worktreeId: 'worktree-cleanup',
      setupState: 'ready'
    })
    store.setMergeProgress({
      watcherId: 'watcher-1',
      mergeId: 'merge',
      epoch: 0,
      childInstanceId: 'swarm[task-a]',
      state: 'applied'
    })
    const marker = pipelineChildWorktreeMarker({
      watcherId: 'watcher-1',
      instanceId: 'swarm[task-a]',
      epoch: 0
    })
    const assertHeld = vi.fn(async () => {})
    const policy = createPipelineConcurrencyPolicy({
      runtime: runtimeFor(marker),
      pipelineStore: store
    })

    await expect(
      policy.cleanupWorkspaces!(emptyLedger(), cleanupContext(null, assertHeld))
    ).resolves.toBe(true)
    expect(store.facts('watcher-1').childWorktrees[0]?.setupState).toBe('removed')
    await expect(
      policy.cleanupWorkspaces!(emptyLedger(), cleanupContext(null, assertHeld))
    ).resolves.toBe(false)
    expect(assertHeld).toHaveBeenCalledTimes(4)
  })

  it('does not confuse clean or failed cleanup with a world change', async () => {
    const store = createInMemoryPipelineStore()
    store.recordChildWorktree({
      watcherId: 'watcher-1',
      instanceId: 'swarm[task-a]',
      epoch: 0,
      worktreeId: 'worktree-cleanup',
      setupState: 'ready'
    })
    const leaseAssert = vi.fn(async () => {})
    const policy = createPipelineConcurrencyPolicy({
      runtime: runtimeFor('unowned-worktree'),
      pipelineStore: store
    })

    await expect(
      policy.cleanupWorkspaces!(emptyLedger(), cleanupContext(null, leaseAssert))
    ).resolves.toBe(false)
    expect(store.facts('watcher-1').childWorktrees[0]?.setupState).toBe('ready')
    expect(leaseAssert).toHaveBeenCalledTimes(2)
  })

  it('keeps an ineligible child but cleans it after the run becomes terminal', async () => {
    const store = createInMemoryPipelineStore()
    store.recordChildWorktree({
      watcherId: 'watcher-1',
      instanceId: 'swarm[task-a]',
      epoch: 0,
      worktreeId: 'worktree-cleanup',
      setupState: 'ready'
    })
    const marker = pipelineChildWorktreeMarker({
      watcherId: 'watcher-1',
      instanceId: 'swarm[task-a]',
      epoch: 0
    })
    const assertHeld = vi.fn(async () => {})
    const policy = createPipelineConcurrencyPolicy({
      runtime: runtimeFor(marker),
      pipelineStore: store
    })

    await expect(
      policy.cleanupWorkspaces!(emptyLedger(), cleanupContext(null, assertHeld))
    ).resolves.toBe(false)
    expect(store.facts('watcher-1').childWorktrees[0]?.setupState).toBe('ready')
    await expect(
      policy.cleanupWorkspaces!(emptyLedger(), cleanupContext(10, assertHeld))
    ).resolves.toBe(true)
    expect(store.facts('watcher-1').childWorktrees[0]?.setupState).toBe('removed')
    expect(assertHeld).toHaveBeenCalledTimes(4)
  })
})
