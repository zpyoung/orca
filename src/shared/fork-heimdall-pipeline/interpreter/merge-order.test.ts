import { describe, expect, it } from 'vitest'
import type { ApprovalScope, WatcherLedger } from '../../fork-heimdall/ledger-types'
import { makeAttemptFingerprint } from '../../fork-heimdall/attempt-fingerprint'
import { parsePipelineNodeEvidenceKey } from '../choice-types'
import { scriptApprovalDigest } from '../script-env'
import type { TaskList } from '../task-list'
import {
  answerEvidence,
  attemptEntry,
  emptyLedger,
  nodeOutputs,
  pipelinePayload,
  world
} from '../interpreter-test-harness'
import type { PipelineMergeSourceFacts, PipelineWorld } from './index'
import { buildPipelineAction } from './action-envelope'
import { decidePipelineTick } from './decide'
import { mergeOrder } from './merge-order'
import { derivePipelineRunState } from './run-state'

const TASKS: TaskList = [
  { id: 't1', title: 'First task', spec: 'Implement the first change' },
  { id: 't3', title: 'Task after t2', spec: 'Implement after the prerequisite', deps: ['t2'] },
  { id: 't2', title: 'Prerequisite task', spec: 'Prepare the dependent change' }
]

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
    maxParallel: 3
    worktree: shared
    child:
      harness: codex
      prompt: $task.spec
  - id: merge
    type: merge
    after: [swarm]
    from: swarm
`

function mergeSources(): Readonly<Record<string, PipelineMergeSourceFacts>> {
  return {
    'swarm[t1]': {
      childInstanceId: 'swarm[t1]',
      workspacePath: '/workspace/t1',
      sourceHead: 'head-t1',
      committedChildSha: 'commit-t1',
      workspaceDigest: 'digest-t1',
      applicableBaseCommit: 'base-run',
      unmergedPaths: []
    },
    'swarm[t2]': {
      childInstanceId: 'swarm[t2]',
      workspacePath: '/workspace/t2',
      sourceHead: 'head-t2',
      committedChildSha: 'commit-t2',
      workspaceDigest: 'digest-t2',
      applicableBaseCommit: 'applied-t1',
      unmergedPaths: []
    },
    'swarm[t3]': {
      childInstanceId: 'swarm[t3]',
      workspacePath: '/workspace/t3',
      sourceHead: 'head-t3',
      committedChildSha: 'commit-t3',
      workspaceDigest: 'digest-t3',
      applicableBaseCommit: 'applied-t2',
      unmergedPaths: []
    }
  }
}

function mergeWorld(
  mergeProgress: PipelineWorld['facts']['mergeProgress'] = [],
  yamlText = MERGE_YAML
): PipelineWorld {
  const payload = pipelinePayload(yamlText)
  const initialWorld = world({ payload })
  const facts = {
    ...initialWorld.facts,
    outputs: [nodeOutputs('plan', 0, 0, { tasks: TASKS })],
    swarmExpansions: [
      { swarmId: 'swarm', epoch: 0, tasks: TASKS, warnings: [], baseCommit: 'base-run' }
    ],
    mergeProgress
  }
  return world({ payload, facts, mergeSources: mergeSources() })
}

function planAction(runWorld: PipelineWorld) {
  return buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'external',
    pin: runWorld.payload.pin,
    instanceId: 'plan',
    nodeId: 'plan',
    epoch: 0,
    attempt: 0
  })
}

function childAction(runWorld: PipelineWorld, taskId: string) {
  return buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'external',
    pin: runWorld.payload.pin,
    instanceId: `swarm[${taskId}]`,
    nodeId: 'swarm',
    epoch: 0,
    attempt: 0,
    fields: {
      agent: 'codex',
      ...(runWorld.payload.document.defaults?.model === undefined
        ? {}
        : { model: runWorld.payload.document.defaults.model }),
      ...(runWorld.payload.document.defaults?.effort === undefined
        ? {}
        : { effort: runWorld.payload.document.defaults.effort })
    }
  })
}

function mergeLedger(runWorld: PipelineWorld, childState?: 'running' | 'failed'): WatcherLedger {
  const entries = [attemptEntry(planAction(runWorld), 'settled', 1_000, { effect: 'landed' })]
  for (const task of TASKS) {
    const action = childAction(runWorld, task.id)
    if (task.id === 't1' && childState === 'running') {
      entries.push(attemptEntry(action, 'running', 2_000, { dispatchId: 'dispatch-t1' }))
    } else if (task.id === 't1' && childState === 'failed') {
      entries.push(
        attemptEntry(action, 'settled', 2_000, {
          effect: 'not-landed',
          reason: 'Child failed'
        })
      )
    } else {
      entries.push(attemptEntry(action, 'settled', 2_000, { effect: 'landed' }))
    }
  }
  return emptyLedger(entries)
}

function runState(runWorld: PipelineWorld, ledger: WatcherLedger) {
  return derivePipelineRunState({
    payload: runWorld.payload,
    facts: runWorld.facts,
    ledger,
    nowMs: runWorld.nowMs,
    unverifiableDispatchIds: runWorld.unverifiableDispatchIds
  })
}

function appliedProgress(childInstanceId: string, commitSha: string, appliedCommitSha: string) {
  return {
    mergeId: 'merge',
    epoch: 0,
    childInstanceId,
    state: 'applied' as const,
    commitSha,
    appliedCommitSha,
    conflict: null
  }
}
function conflictProgress(state: 'conflict' | 'resolving' | 'resolved' = 'conflict') {
  return {
    mergeId: 'merge',
    epoch: 0,
    childInstanceId: 'swarm[t1]',
    state,
    commitSha: 'commit-t1',
    appliedCommitSha: null,
    conflict: { paths: ['src/shared/item.ts'], conflictingChildren: [] }
  }
}

function mergeConflictWorld(
  base: PipelineWorld,
  progress: ReturnType<typeof conflictProgress>,
  options: {
    terminalHandle?: string | null
    sourceHead?: string
    committedChildSha?: string | null
    workspaceDigest?: string
    applicableBaseCommit?: string
    unmergedPaths?: string[]
  } = {}
): PipelineWorld {
  const source = base.mergeSources?.['swarm[t1]']
  if (source === undefined) {
    throw new Error('Missing test Merge source')
  }
  const facts = {
    ...base.facts,
    dispatches: [
      {
        instanceId: 'swarm[t1]',
        epoch: 0,
        attempt: 0,
        dispatchId: 'dispatch-t1',
        workspaceId: 'worktree-t1',
        terminalHandle:
          options.terminalHandle === undefined ? 'terminal-t1' : options.terminalHandle,
        reportPath: '/workspace/.orca/child-report.json',
        dispatchedAtMs: 2_000
      }
    ],
    childWorktrees: [
      {
        instanceId: 'swarm[t1]',
        epoch: 0,
        worktreeId: 'worktree-t1',
        setupState: 'ready'
      }
    ],
    mergeProgress: [progress]
  }
  const mergeSources = {
    ...base.mergeSources,
    'swarm[t1]': {
      ...source,
      sourceHead: options.sourceHead ?? source.sourceHead,
      committedChildSha:
        options.committedChildSha === undefined ? progress.commitSha : options.committedChildSha,
      workspaceDigest: options.workspaceDigest ?? source.workspaceDigest,
      applicableBaseCommit: options.applicableBaseCommit ?? source.applicableBaseCommit,
      unmergedPaths: options.unmergedPaths ?? ['src/shared/item.ts']
    }
  }
  return world({ ...base, facts, mergeSources })
}

function append(ledger: WatcherLedger, ...entries: WatcherLedger['entries']): WatcherLedger {
  return { ...ledger, entries: [...ledger.entries, ...entries] }
}

describe('Merge ordering and application', () => {
  it('orders dependencies before dependents, breaks ties by task order, and omits skipped children', () => {
    expect(mergeOrder(TASKS)).toEqual(['t1', 't2', 't3'])
    expect(mergeOrder(TASKS, new Set(['t1']))).toEqual(['t2', 't3'])
  })

  it.each(['running', 'failed'] as const)('waits while any child is %s', (childState) => {
    const runWorld = mergeWorld()
    const state = runState(runWorld, mergeLedger(runWorld, childState))

    expect(state.nodes.get('merge')?.status).toBe('pending')
    expect(state.nodes.get('swarm[t1]')?.status).toBe(childState)
  })

  it('keeps a Merge node running while an owned conflict resolver is in progress', () => {
    const runWorld = mergeWorld([conflictProgress('resolving')])
    const ledger = mergeLedger(runWorld)

    expect(runState(runWorld, ledger).nodes.get('merge')?.status).toBe('running')
    expect(decidePipelineTick(runWorld, ledger).action).toBeNull()
  })

  it('marks an unverifiable conflict resolver without retrying or timing out its Merge node', () => {
    const runWorld = mergeWorld([conflictProgress('resolving')])
    const resolverAction = buildPipelineAction({
      kind: 'pipeline-resolve-merge-conflict',
      capability: 'agent',
      visibility: 'local',
      pin: runWorld.payload.pin,
      instanceId: 'merge[t1]',
      nodeId: 'merge',
      epoch: 0,
      attempt: 0,
      step: 'resolver',
      fields: { mergeId: 'merge', childInstanceId: 'swarm[t1]' }
    })
    const ledger = append(
      mergeLedger(runWorld),
      attemptEntry(resolverAction, 'running', 3_000, { dispatchId: 'resolver-dispatch' })
    )
    const unverifiableWorld = world({
      ...runWorld,
      facts: {
        ...runWorld.facts,
        dispatches: [
          {
            instanceId: 'merge[t1]',
            epoch: 0,
            attempt: 0,
            dispatchId: 'resolver-dispatch',
            workspaceId: 'resolver-workspace',
            terminalHandle: 'resolver-terminal',
            reportPath: '/workspace/.orca/resolver-report.json',
            dispatchedAtMs: 3_000
          }
        ]
      },
      unverifiableDispatchIds: new Set(['resolver-dispatch'])
    })
    expect(runState(unverifiableWorld, ledger).nodes.get('merge')?.status).toBe('unverifiable')
    expect(runState(unverifiableWorld, ledger).deadlines).toEqual([])
    expect(decidePipelineTick(unverifiableWorld, ledger).action).toBeNull()
  })

  it('offers a conflict choice instead of applying more children while the merge is conflicted', () => {
    const conflict = {
      mergeId: 'merge',
      epoch: 0,
      childInstanceId: 'swarm[t1]',
      state: 'conflict' as const,
      commitSha: 'commit-t1',
      appliedCommitSha: null,
      conflict: { paths: ['src/shared/item.ts'], conflictingChildren: [] }
    }
    const runWorld = mergeWorld([conflict])
    const ledger = mergeLedger(runWorld)

    expect(runState(runWorld, ledger).nodes.get('merge')).toMatchObject({
      status: 'waiting',
      waitingFor: 'choice'
    })
    expect(decidePipelineTick(runWorld, ledger).action).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'merge-conflict',
      options: ['retry', 'skip', 'abort']
    })
  })

  it('resolves an owned Merge conflict once and applies only after a landed resolver', () => {
    const privateYaml = MERGE_YAML.replace(
      'name: Merge run',
      'name: Merge run\ndefaults:\n  model: model-1\n  effort: high'
    ).replace('worktree: shared', 'worktree: own')
    const privateWorld = mergeWorld([], privateYaml)
    const initialLedger = mergeLedger(privateWorld)
    const integration = decidePipelineTick(privateWorld, initialLedger).action
    if (integration === null || integration.kind !== 'pipeline-merge-child') {
      throw new Error('Expected the initial child integration')
    }
    const progress = { ...conflictProgress(), commitSha: 'normalized-conflict-t1' }
    const conflictWorld = mergeConflictWorld(privateWorld, progress, {
      sourceHead: 'normalized-conflict-t1',
      workspaceDigest: 'normalized-digest-t1',
      unmergedPaths: []
    })
    const failedIntegration = attemptEntry(integration, 'settled', 3_000, {
      effect: 'not-landed',
      reason: 'Cherry-pick conflict'
    })
    const ledger = append(initialLedger, failedIntegration)
    const resolver = decidePipelineTick(conflictWorld, ledger).action

    expect(resolver).toMatchObject({
      kind: 'pipeline-resolve-merge-conflict',
      capability: 'agent',
      visibility: 'local',
      mergeId: 'merge',
      childInstanceId: 'swarm[t1]',
      taskId: 't1',
      childWorkspacePath: '/workspace/t1',
      childCommitSha: 'normalized-conflict-t1',
      originalChildCommitSha: 'commit-t1',
      sourceHead: 'head-t1',
      workspaceDigest: 'digest-t1',
      baseCommit: 'base-run',
      originalMergeStep: parsePipelineNodeEvidenceKey(integration.evidenceKey)?.step,
      originalMergeEpoch: 0,
      originalMergeAttemptId: failedIntegration.attemptId,
      originalMergeAttemptFingerprint: failedIntegration.fingerprint,
      currentSourceHead: 'normalized-conflict-t1',
      currentWorkspaceDigest: 'normalized-digest-t1',
      mergedHead: 'base-run',
      conflictPaths: ['src/shared/item.ts'],
      conflictingChildren: [],
      appliedChildren: [],
      harness: 'codex',
      model: 'model-1',
      effort: 'high',
      workspaceId: 'worktree-t1',
      reuseTerminal: 'terminal-t1'
    })
    if (resolver === null || resolver.kind !== 'pipeline-resolve-merge-conflict') {
      throw new Error('Expected an owned conflict resolver action')
    }
    expect(resolver.pipelineNode).toMatchObject({
      instanceId: 'merge[t1]',
      nodeId: 'merge',
      epoch: 0,
      attempt: 1
    })
    const resolverStep = parsePipelineNodeEvidenceKey(resolver.evidenceKey)?.step
    expect(resolverStep).toBeDefined()
    expect(JSON.parse(resolverStep ?? '[]')).toEqual([
      'merge-conflict-resolver',
      'merge',
      'swarm[t1]',
      parsePipelineNodeEvidenceKey(integration.evidenceKey)?.step,
      0,
      failedIntegration.attemptId,
      failedIntegration.fingerprint,
      'commit-t1',
      'head-t1',
      'digest-t1',
      'base-run',
      'normalized-conflict-t1',
      'normalized-conflict-t1',
      'normalized-digest-t1',
      'base-run',
      '/workspace/t1',
      ['src/shared/item.ts'],
      [],
      [],
      'codex',
      'model-1',
      'high',
      'worktree-t1',
      'terminal-t1'
    ])

    const runningLedger = append(
      ledger,
      attemptEntry(resolver, 'running', 4_000, { dispatchId: 'resolver-dispatch' })
    )
    const changedWorld = mergeConflictWorld(privateWorld, progress, {
      terminalHandle: 'changed-terminal',
      sourceHead: 'changing-head',
      workspaceDigest: 'changing-digest'
    })
    expect(decidePipelineTick(changedWorld, runningLedger).action).toBeNull()

    const failedResolverLedger = append(
      ledger,
      attemptEntry(resolver, 'settled', 5_000, {
        effect: 'not-landed',
        reason: 'The resolver left conflict markers'
      })
    )
    const conflictChoice = decidePipelineTick(conflictWorld, failedResolverLedger).action
    expect(conflictChoice).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'merge-conflict',
      options: ['retry', 'skip', 'abort']
    })
    if (conflictChoice === null || conflictChoice.kind !== 'pipeline-apply-choice') {
      throw new Error('Expected a Merge conflict choice after resolver failure')
    }
    const answeredLedger = append(
      failedResolverLedger,
      answerEvidence(
        {
          actionKind: conflictChoice.kind,
          contentIdentity: conflictChoice.contentIdentity,
          evidenceKey: conflictChoice.evidenceKey
        },
        'retry'
      )
    )
    const retryControl = decidePipelineTick(conflictWorld, answeredLedger).action
    if (retryControl === null || retryControl.kind !== 'pipeline-apply-choice') {
      throw new Error('Expected the answered Merge retry control')
    }
    const landedRetryLedger = append(
      answeredLedger,
      attemptEntry(retryControl, 'settled', 5_500, { effect: 'landed' })
    )
    const retriedProgress = { ...progress, epoch: 1 }
    const retriedBaseWorld = mergeConflictWorld(privateWorld, retriedProgress, {
      sourceHead: 'normalized-conflict-t1',
      workspaceDigest: 'normalized-digest-t1',
      unmergedPaths: []
    })
    const retriedWorld = world({
      ...retriedBaseWorld,
      facts: {
        ...retriedBaseWorld.facts,
        mergeProgress: [progress, retriedProgress]
      }
    })
    const retriedResolver = decidePipelineTick(retriedWorld, landedRetryLedger).action
    expect(retriedResolver).toMatchObject({
      kind: 'pipeline-resolve-merge-conflict',
      childInstanceId: 'swarm[t1]'
    })
    if (retriedResolver === null || retriedResolver.kind !== 'pipeline-resolve-merge-conflict') {
      throw new Error('Expected one new resolver for the retried Merge epoch')
    }
    expect(retriedResolver).toMatchObject({
      originalMergeEpoch: 0,
      originalMergeAttemptId: failedIntegration.attemptId,
      originalMergeAttemptFingerprint: failedIntegration.fingerprint,
      originalMergeStep: parsePipelineNodeEvidenceKey(integration.evidenceKey)?.step
    })
    expect(retriedResolver.pipelineNode).toMatchObject({ epoch: 1, attempt: 0 })
    expect(retriedResolver.evidenceKey).not.toBe(resolver.evidenceKey)

    const resolvedProgress = { ...retriedProgress, state: 'resolved' as const }
    const resolvedBaseWorld = mergeConflictWorld(privateWorld, resolvedProgress, {
      sourceHead: 'resolved-commit',
      committedChildSha: 'resolved-commit',
      workspaceDigest: 'resolved-digest',
      unmergedPaths: []
    })
    const resolvedWorld = world({
      ...resolvedBaseWorld,
      facts: {
        ...resolvedBaseWorld.facts,
        mergeProgress: [progress, resolvedProgress]
      }
    })
    const verifiedLedger = append(
      landedRetryLedger,
      attemptEntry(retriedResolver, 'settled', 6_000, { effect: 'landed' })
    )
    const freshMerge = decidePipelineTick(resolvedWorld, verifiedLedger).action
    expect(freshMerge).toMatchObject({
      kind: 'pipeline-merge-child',
      childInstanceId: 'swarm[t1]',
      childCommitSha: 'resolved-commit',
      baseCommit: 'base-run'
    })
    if (freshMerge === null || freshMerge.kind !== 'pipeline-merge-child') {
      throw new Error('Expected a fresh Merge application after verified conflict resolution')
    }
    expect(freshMerge.evidenceKey).not.toBe(integration.evidenceKey)
    expect(freshMerge.evidenceKey).not.toBe(retriedResolver.evidenceKey)
  })

  it('binds resolver provenance to a normalized commit created from an uncommitted child worktree', () => {
    const privateWorld = mergeWorld([], MERGE_YAML.replace('worktree: shared', 'worktree: own'))
    const source = privateWorld.mergeSources?.['swarm[t1]']
    if (source === undefined) {
      throw new Error('Missing test Merge source')
    }
    const worktreeWorld = world({
      ...privateWorld,
      mergeSources: {
        ...privateWorld.mergeSources,
        'swarm[t1]': { ...source, committedChildSha: null }
      }
    })
    const initialLedger = mergeLedger(worktreeWorld)
    const integration = decidePipelineTick(worktreeWorld, initialLedger).action
    if (integration === null || integration.kind !== 'pipeline-merge-child') {
      throw new Error('Expected the uncommitted child integration')
    }
    expect(integration.childCommitSha).toBeNull()
    expect(JSON.parse(parsePipelineNodeEvidenceKey(integration.evidenceKey)?.step ?? '[]')).toEqual(
      ['swarm[t1]', ['worktree', 'head-t1', 'digest-t1'], 'base-run']
    )
    const progress = { ...conflictProgress(), commitSha: 'normalized-child-t1' }
    const conflictWorld = mergeConflictWorld(worktreeWorld, progress, {
      sourceHead: 'normalized-child-t1',
      workspaceDigest: 'normalized-child-digest',
      unmergedPaths: []
    })
    const failedIntegration = attemptEntry(integration, 'settled', 3_000, {
      effect: 'not-landed',
      reason: 'Cherry-pick conflict'
    })
    const ledger = append(initialLedger, failedIntegration)
    expect(decidePipelineTick(conflictWorld, ledger).action).toMatchObject({
      kind: 'pipeline-resolve-merge-conflict',
      childInstanceId: 'swarm[t1]',
      childCommitSha: 'normalized-child-t1',
      originalChildCommitSha: null,
      sourceHead: 'head-t1',
      workspaceDigest: 'digest-t1',
      baseCommit: 'base-run',
      originalMergeEpoch: 0,
      originalMergeAttemptId: failedIntegration.attemptId,
      originalMergeAttemptFingerprint: failedIntegration.fingerprint,
      currentSourceHead: 'normalized-child-t1',
      currentWorkspaceDigest: 'normalized-child-digest',
      mergedHead: 'base-run'
    })
  })

  it('routes an owned conflict to a choice when no retained child terminal is available', () => {
    const privateWorld = mergeWorld([], MERGE_YAML.replace('worktree: shared', 'worktree: own'))
    const initialLedger = mergeLedger(privateWorld)
    const integration = decidePipelineTick(privateWorld, initialLedger).action
    if (integration === null || integration.kind !== 'pipeline-merge-child') {
      throw new Error('Expected the initial child integration')
    }
    const conflictWorld = mergeConflictWorld(privateWorld, conflictProgress(), {
      terminalHandle: null
    })
    const failedIntegration = attemptEntry(integration, 'settled', 3_000, {
      effect: 'not-landed',
      reason: 'Cherry-pick conflict'
    })
    const ledger = append(initialLedger, failedIntegration)

    const offered = decidePipelineTick(conflictWorld, ledger).action
    expect(offered).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'merge-conflict',
      options: ['retry', 'skip', 'abort'],
      conflictingChildInstanceId: 'swarm[t1]',
      originalChildCommitSha: 'commit-t1',
      sourceHead: 'head-t1',
      workspaceDigest: 'digest-t1',
      baseCommit: 'base-run',
      originalMergeStep: parsePipelineNodeEvidenceKey(integration.evidenceKey)?.step,
      originalMergeEpoch: 0,
      originalMergeAttemptId: failedIntegration.attemptId,
      originalMergeAttemptFingerprint: failedIntegration.fingerprint
    })
    if (offered === null || offered.kind !== 'pipeline-apply-choice') {
      throw new Error('Expected a Merge conflict choice')
    }
    const answeredLedger = append(
      ledger,
      answerEvidence(
        {
          actionKind: offered.kind,
          contentIdentity: offered.contentIdentity,
          evidenceKey: offered.evidenceKey
        },
        'retry'
      )
    )
    const retryControl = decidePipelineTick(conflictWorld, answeredLedger).action
    if (retryControl === null || retryControl.kind !== 'pipeline-apply-choice') {
      throw new Error('Expected the answered Merge retry control')
    }
    expect(retryControl).toMatchObject({
      originalMergeStep: parsePipelineNodeEvidenceKey(integration.evidenceKey)?.step,
      originalMergeEpoch: 0,
      originalMergeAttemptId: failedIntegration.attemptId,
      originalMergeAttemptFingerprint: failedIntegration.fingerprint
    })
    const inFlightLedger = append(
      answeredLedger,
      attemptEntry(retryControl, 'running', 4_000, { dispatchId: 'merge-choice-dispatch' })
    )
    const availableWorld = mergeConflictWorld(privateWorld, conflictProgress())
    expect(decidePipelineTick(availableWorld, inFlightLedger).action).toBeNull()
  })

  it('offers a merge-conflict choice for a child without a private workspace path', () => {
    const sharedWorld = mergeWorld()
    const source = sharedWorld.mergeSources?.['swarm[t1]']
    if (source === undefined) {
      throw new Error('Missing test Merge source')
    }
    const initialLedger = mergeLedger(sharedWorld)
    const integration = decidePipelineTick(sharedWorld, initialLedger).action
    if (integration === null || integration.kind !== 'pipeline-merge-child') {
      throw new Error('Expected the initial child integration')
    }
    const conflictWorld = mergeConflictWorld(sharedWorld, conflictProgress())
    const unavailableWorld = world({
      ...conflictWorld,
      mergeSources: {
        ...conflictWorld.mergeSources,
        'swarm[t1]': { ...source, workspacePath: null }
      }
    })
    const ledger = append(
      initialLedger,
      attemptEntry(integration, 'settled', 3_000, {
        effect: 'not-landed',
        reason: 'Cherry-pick conflict'
      })
    )

    expect(decidePipelineTick(unavailableWorld, ledger).action).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'merge-conflict'
    })
  })

  it.each(['agent', 'integrate'] as const)(
    'routes to a conflict choice when %s capability is off',
    (capability) => {
      const privateWorld = mergeWorld([], MERGE_YAML.replace('worktree: shared', 'worktree: own'))
      const baseLedger = mergeLedger(privateWorld)
      const integration = decidePipelineTick(privateWorld, baseLedger).action
      if (integration === null || integration.kind !== 'pipeline-merge-child') {
        throw new Error('Expected the initial child integration')
      }
      const conflictWorld = mergeConflictWorld(privateWorld, conflictProgress())
      const restrictedWorld = world({
        ...conflictWorld,
        grants: { ...conflictWorld.grants, [capability]: 'off' }
      })
      const ledger = append(
        baseLedger,
        attemptEntry(integration, 'settled', 3_000, {
          effect: 'not-landed',
          reason: 'Cherry-pick conflict'
        })
      )

      expect(decidePipelineTick(restrictedWorld, ledger).action).toMatchObject({
        kind: 'pipeline-apply-choice',
        cause: 'merge-conflict'
      })
    }
  )

  it('skips the conflicting Merge child only after the answered control lands', () => {
    const conflict = {
      mergeId: 'merge',
      epoch: 0,
      childInstanceId: 'swarm[t2]',
      state: 'conflict' as const,
      commitSha: 'commit-t2',
      appliedCommitSha: null,
      conflict: { paths: ['src/shared/item.ts'], conflictingChildren: ['t1'] }
    }
    const runWorld = mergeWorld([appliedProgress('swarm[t1]', 'commit-t1', 'applied-t1'), conflict])
    const initialLedger = mergeLedger(runWorld)
    const offered = decidePipelineTick(runWorld, initialLedger).action
    expect(offered).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'merge-conflict',
      conflictingChildInstanceId: 'swarm[t2]',
      conflictingChildren: ['t1'],
      conflictPaths: ['src/shared/item.ts']
    })
    if (offered === null || offered.kind !== 'pipeline-apply-choice') {
      throw new Error('Expected a Merge conflict control')
    }
    const scope: ApprovalScope = {
      actionKind: offered.kind,
      contentIdentity: offered.contentIdentity,
      evidenceKey: offered.evidenceKey
    }
    const answeredLedger = emptyLedger([...initialLedger.entries, answerEvidence(scope, 'skip')])
    const control = decidePipelineTick(runWorld, answeredLedger).action
    expect(control).toMatchObject({ kind: 'pipeline-apply-choice', choice: 'skip' })
    if (control === null || control.kind !== 'pipeline-apply-choice') {
      throw new Error('Expected the answered Merge skip control')
    }
    expect(runState(runWorld, answeredLedger).nodes.get('swarm[t2]')?.status).toBe('done')

    const failedControlLedger = emptyLedger([
      ...answeredLedger.entries,
      attemptEntry(control, 'settled', 3_000, { effect: 'not-landed' })
    ])
    expect(runState(runWorld, failedControlLedger).nodes.get('swarm[t2]')?.status).toBe('done')

    const landedControlLedger = emptyLedger([
      ...answeredLedger.entries,
      attemptEntry(control, 'settled', 4_000, { effect: 'landed' })
    ])
    expect(runState(runWorld, landedControlLedger).nodes.get('swarm[t2]')?.status).toBe('skipped')
    expect(runState(runWorld, landedControlLedger).nodes.get('swarm[t1]')?.status).toBe('done')
  })

  it('gives successive child applications distinct attempt identities bound to child, commit, and base', () => {
    const firstWorld = mergeWorld()
    const childLedger = mergeLedger(firstWorld)
    const first = decidePipelineTick(firstWorld, childLedger).action
    expect(first).toMatchObject({
      kind: 'pipeline-merge-child',
      childInstanceId: 'swarm[t1]'
    })
    if (first === null || first.kind !== 'pipeline-merge-child') {
      throw new Error('Expected the first Merge child application')
    }

    const nextWorld = mergeWorld([appliedProgress('swarm[t1]', 'commit-t1', 'applied-t1')])
    const second = decidePipelineTick(nextWorld, mergeLedger(nextWorld)).action
    expect(second).toMatchObject({
      kind: 'pipeline-merge-child',
      childInstanceId: 'swarm[t2]'
    })
    if (second === null || second.kind !== 'pipeline-merge-child') {
      throw new Error('Expected the next Merge child application')
    }

    const firstStep = parsePipelineNodeEvidenceKey(first.evidenceKey)?.step
    const secondStep = parsePipelineNodeEvidenceKey(second.evidenceKey)?.step
    expect(firstStep).toBeDefined()
    expect(secondStep).toBeDefined()
    expect(JSON.parse(firstStep ?? '[]')).toEqual([
      'swarm[t1]',
      ['commit', 'commit-t1'],
      'base-run'
    ])
    expect(JSON.parse(secondStep ?? '[]')).toEqual([
      'swarm[t2]',
      ['commit', 'commit-t2'],
      'applied-t1'
    ])
    expect(makeAttemptFingerprint(first.contentIdentity, first.kind, first.evidenceKey)).not.toBe(
      makeAttemptFingerprint(second.contentIdentity, second.kind, second.evidenceKey)
    )
  })

  it('binds Script step identity to its command and resolved environment digest', () => {
    const scriptYaml = `version: 1
id: script-run
name: Script run
nodes:
  - id: source
    type: agent
    prompt: Produce a value
    outputs:
      value:
        type: text
  - id: run
    type: script
    after: [source]
    command: 'printf "%s" "$VALUE"'
    capability: script
    inputs:
      VALUE: $source.outputs.value
`
    const scriptWorld = (value: string) => {
      const payload = pipelinePayload(scriptYaml)
      const initialWorld = world({ payload })
      const facts = {
        ...initialWorld.facts,
        outputs: [nodeOutputs('source', 0, 0, { value })]
      }
      return world({ payload, facts })
    }
    const actionForValue = (runWorld: PipelineWorld) => {
      const source = buildPipelineAction({
        kind: 'pipeline-dispatch-agent',
        capability: 'agent',
        visibility: 'external',
        pin: runWorld.payload.pin,
        instanceId: 'source',
        nodeId: 'source',
        epoch: 0,
        attempt: 0
      })
      const ledger = emptyLedger([attemptEntry(source, 'settled', 1_000, { effect: 'landed' })])
      return decidePipelineTick(runWorld, ledger).action
    }

    const first = actionForValue(scriptWorld('first'))
    const second = actionForValue(scriptWorld('second'))
    expect(first).toMatchObject({
      kind: 'pipeline-run-script',
      command: 'printf "%s" "$VALUE"',
      env: { VALUE: 'first' }
    })
    expect(second).toMatchObject({ kind: 'pipeline-run-script', env: { VALUE: 'second' } })
    if (
      first === null ||
      first.kind !== 'pipeline-run-script' ||
      second === null ||
      second.kind !== 'pipeline-run-script'
    ) {
      throw new Error('Expected Script actions')
    }

    const firstDigest = scriptApprovalDigest({
      command: 'printf "%s" "$VALUE"',
      env: { VALUE: 'first' }
    })
    const secondDigest = scriptApprovalDigest({
      command: 'printf "%s" "$VALUE"',
      env: { VALUE: 'second' }
    })
    expect(parsePipelineNodeEvidenceKey(first.evidenceKey)?.step).toBe(`script:${firstDigest}`)
    expect(parsePipelineNodeEvidenceKey(second.evidenceKey)?.step).toBe(`script:${secondDigest}`)
    expect(firstDigest).not.toBe(secondDigest)
    expect(first.evidenceKey).not.toBe(second.evidenceKey)
  })
})
