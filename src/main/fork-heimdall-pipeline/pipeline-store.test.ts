import { describe, expect, it } from 'vitest'

import type { PipelinePin } from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import { createInMemoryPipelineStore } from './pipeline-store-test-fixtures'

const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`

function pin(ref: string, id: string, contentHash = HASH_A): PipelinePin {
  return { ref, scope: 'repo', id, contentHash, documentVersion: 1 }
}

describe('PipelineStore run pins', () => {
  it('assigns run numbers per ref, keeps each watcher pin immutable, and filters to live watchers', () => {
    const store = createInMemoryPipelineStore()
    const firstPin = pin('bugfix', 'pipeline-first')
    const secondPin = pin('bugfix', 'pipeline-second', HASH_B)
    const otherRefPin = pin('release', 'pipeline-release')

    const firstSource = { sourceText: 'original pinned source' }
    expect(store.recordRunPin('watcher-1', firstPin, 100, firstSource)).toEqual({ runNumber: 1 })
    expect(store.recordRunPin('watcher-2', secondPin, 200)).toEqual({ runNumber: 2 })
    expect(store.recordRunPin('watcher-3', otherRefPin, 300)).toEqual({ runNumber: 1 })
    expect(
      store.recordRunPin('watcher-1', secondPin, 400, { sourceText: 'replacement source' })
    ).toEqual({ runNumber: 1 })
    expect(store.runPin('watcher-1')).toEqual({ ...firstPin, runNumber: 1 })
    expect(store.runSource('watcher-1')).toEqual(firstSource)
    expect(store.liveRunsForRef('bugfix', new Set(['watcher-2', 'deleted-watcher']))).toEqual([
      { watcherId: 'watcher-2', runNumber: 2, contentHash: HASH_B }
    ])
    expect(store.liveRunsForRef('release', new Set())).toEqual([])
  })
})

describe('PipelineStore persisted facts', () => {
  it('round-trips outputs, dispatches, baselines, expansions, worktrees, merges, and composites', () => {
    const store = createInMemoryPipelineStore()
    const runPin = pin('feature/pipeline', 'pipeline-facts')
    const tasks: PipelineStoreFacts['swarmExpansions'][number]['tasks'] = [
      { id: 'child-a', title: 'First child', spec: 'Implement the first slice.' },
      { id: 'child-b', title: 'Second child', spec: 'Implement the second slice.' }
    ]
    const warnings: PipelineStoreFacts['swarmExpansions'][number]['warnings'] = [
      { code: 'territory-overlap', taskIds: ['child-a', 'child-b'], paths: ['src/shared'] }
    ]
    const conflict = { paths: ['src/conflict.ts'], conflictingChildren: ['child-a'] }
    const kindPayload = { reviewId: 'review-1', summary: 'Hosted review attached.' }
    const capabilities = { merge: 'gated' as const, push: 'off' as const }

    store.recordRunPin('watcher-facts', runPin, 1_000)
    store.recordNodeOutput({
      watcherId: 'watcher-facts',
      instanceId: 'node-a',
      epoch: 2,
      attempt: 3,
      outputs: { result: { value: 42 }, approved: true },
      reportSha256: 'report-sha256',
      reportSummary: 'Validated report summary',
      nowMs: 1_100
    })
    store.recordDispatch({
      watcherId: 'watcher-facts',
      instanceId: 'node-a',
      epoch: 2,
      attempt: 3,
      dispatchId: 'dispatch-3',
      workspaceId: null,
      terminalHandle: 'terminal-3',
      reportPath: '/workspace/report.json',
      dispatchedAtMs: 1_200
    })
    store.recordAttemptBaseline({
      watcherId: 'watcher-facts',
      attemptFingerprint: 'fingerprint-3',
      workspacePath: '/workspace',
      digest: { files: ['src/a.ts'], revision: 7 }
    })
    store.recordSwarmExpansion({
      watcherId: 'watcher-facts',
      swarmId: 'swarm-a',
      epoch: 2,
      tasks,
      warnings,
      baseCommit: null
    })
    store.recordChildWorktree({
      watcherId: 'watcher-facts',
      instanceId: 'child-a',
      epoch: 2,
      worktreeId: 'worktree-child-a',
      setupState: 'ready'
    })
    store.setMergeProgress({
      watcherId: 'watcher-facts',
      mergeId: 'merge-a',
      epoch: 2,
      childInstanceId: 'child-a',
      state: 'conflict',
      commitSha: 'child-commit',
      appliedCommitSha: null,
      conflict
    })
    store.recordComposite({
      watcherId: 'watcher-facts',
      instanceId: 'hosted-review',
      epoch: 2,
      kind: 'hosted-review',
      kindPayload,
      capabilities,
      activatedAtMs: 1_300
    })

    expect(store.facts('watcher-facts')).toEqual({
      pin: { ...runPin, runNumber: 1 },
      outputs: [
        {
          instanceId: 'node-a',
          epoch: 2,
          attempt: 3,
          outputs: { result: { value: 42 }, approved: true },
          reportSha256: 'report-sha256',
          reportSummary: 'Validated report summary'
        }
      ],
      dispatches: [
        {
          instanceId: 'node-a',
          epoch: 2,
          attempt: 3,
          dispatchId: 'dispatch-3',
          workspaceId: null,
          terminalHandle: 'terminal-3',
          reportPath: '/workspace/report.json',
          dispatchedAtMs: 1_200
        }
      ],
      swarmExpansions: [{ swarmId: 'swarm-a', epoch: 2, tasks, warnings, baseCommit: null }],
      childWorktrees: [
        { instanceId: 'child-a', epoch: 2, worktreeId: 'worktree-child-a', setupState: 'ready' }
      ],
      mergeProgress: [
        {
          mergeId: 'merge-a',
          epoch: 2,
          childInstanceId: 'child-a',
          state: 'conflict',
          commitSha: 'child-commit',
          appliedCommitSha: null,
          conflict
        }
      ],
      composites: [
        {
          instanceId: 'hosted-review',
          epoch: 2,
          kind: 'hosted-review',
          kindPayload,
          capabilities,
          activatedAtMs: 1_300
        }
      ]
    })
    expect(store.attemptBaseline('watcher-facts', 'fingerprint-3')).toEqual({
      workspacePath: '/workspace',
      digest: { files: ['src/a.ts'], revision: 7 }
    })
    expect(store.composite('watcher-facts', 'hosted-review', 2)).toEqual({
      kind: 'hosted-review',
      kindPayload,
      capabilities,
      activatedAtMs: 1_300
    })
  })

  it('round-trips terminal node outcomes without replacing pinned source or output facts', () => {
    const store = createInMemoryPipelineStore()
    const runPin = pin('terminal-run', 'terminal-run')
    const source = { sourceText: 'version: 1\nid: terminal-run' }
    store.recordRunPin('watcher-terminal', runPin, 1_000, source)
    store.recordNodeOutput({
      watcherId: 'watcher-terminal',
      instanceId: 'report',
      epoch: 2,
      attempt: 3,
      outputs: { result: 'kept' },
      reportSha256: 'report-sha256',
      reportSummary: 'Kept summary',
      nowMs: 1_100
    })
    const nodeStates = [
      {
        instanceId: 'inspect',
        status: 'done' as const,
        epoch: 2,
        attempt: 3,
        startedAtMs: 1_000,
        elapsedMs: 85,
        turns: 7
      },
      {
        instanceId: 'archive',
        status: 'skipped' as const,
        epoch: 1,
        attempt: 0,
        startedAtMs: 1_050,
        elapsedMs: 25,
        turns: 0
      }
    ]

    store.recordTerminalNodeStates('watcher-terminal', nodeStates)

    expect(store.facts('watcher-terminal').terminalNodeStates).toEqual(nodeStates)
    expect(store.runPin('watcher-terminal')).toEqual({ ...runPin, runNumber: 1 })
    expect(store.runSource('watcher-terminal')).toEqual(source)
    expect(store.facts('watcher-terminal').outputs).toEqual([
      {
        instanceId: 'report',
        epoch: 2,
        attempt: 3,
        outputs: { result: 'kept' },
        reportSha256: 'report-sha256',
        reportSummary: 'Kept summary'
      }
    ])
  })

  it('upserts merge state, preserves omitted fields, and clears fields supplied as null', () => {
    const store = createInMemoryPipelineStore()
    const conflict = { paths: ['src/a.ts'], conflictingChildren: ['child-a', 'child-b'] }
    store.setMergeProgress({
      watcherId: 'watcher-merge',
      mergeId: 'merge-a',
      epoch: 4,
      childInstanceId: 'child-a',
      state: 'conflict',
      commitSha: 'child-commit',
      appliedCommitSha: 'merge-commit',
      conflict
    })
    store.setMergeProgress({
      watcherId: 'watcher-merge',
      mergeId: 'merge-a',
      epoch: 4,
      childInstanceId: 'child-a',
      state: 'resolving'
    })

    expect(store.facts('watcher-merge').mergeProgress).toEqual([
      {
        mergeId: 'merge-a',
        epoch: 4,
        childInstanceId: 'child-a',
        state: 'resolving',
        commitSha: 'child-commit',
        appliedCommitSha: 'merge-commit',
        conflict
      }
    ])

    store.setMergeProgress({
      watcherId: 'watcher-merge',
      mergeId: 'merge-a',
      epoch: 4,
      childInstanceId: 'child-a',
      state: 'resolved',
      commitSha: null,
      conflict: null
    })
    expect(store.facts('watcher-merge').mergeProgress).toEqual([
      {
        mergeId: 'merge-a',
        epoch: 4,
        childInstanceId: 'child-a',
        state: 'resolved',
        commitSha: null,
        appliedCommitSha: 'merge-commit',
        conflict: null
      }
    ])
  })

  it('purges every row for one watcher without disturbing any other watcher', () => {
    const store = createInMemoryPipelineStore()
    for (const watcherId of ['watcher-1', 'watcher-2']) {
      store.recordRunPin(watcherId, pin('shared-ref', `${watcherId}-pipeline`), 10, {
        sourceText: `${watcherId} source`
      })
      store.recordNodeOutput({
        watcherId,
        instanceId: 'output-node',
        epoch: 1,
        attempt: 1,
        outputs: { result: watcherId },
        reportSha256: null,
        nowMs: 11
      })
      store.recordDispatch({
        watcherId,
        instanceId: 'dispatch-node',
        epoch: 1,
        attempt: 1,
        dispatchId: `${watcherId}-dispatch`,
        workspaceId: 'workspace-1',
        terminalHandle: null,
        reportPath: '/workspace/report.json',
        dispatchedAtMs: 12
      })
      store.recordAttemptBaseline({
        watcherId,
        attemptFingerprint: `${watcherId}-fingerprint`,
        workspacePath: '/workspace',
        digest: { watcherId }
      })
      store.recordSwarmExpansion({
        watcherId,
        swarmId: 'swarm-a',
        epoch: 1,
        tasks: [{ id: 'child-a', title: 'Child', spec: 'Work.' }],
        warnings: [],
        baseCommit: 'base-commit'
      })
      store.recordChildWorktree({
        watcherId,
        instanceId: 'child-a',
        epoch: 1,
        worktreeId: `${watcherId}-worktree`,
        setupState: 'ready'
      })
      store.setMergeProgress({
        watcherId,
        mergeId: 'merge-a',
        epoch: 1,
        childInstanceId: 'child-a',
        state: 'pending'
      })
      store.recordComposite({
        watcherId,
        instanceId: 'review-a',
        epoch: 1,
        kind: 'hosted-review',
        kindPayload: { watcherId },
        capabilities: { merge: 'gated' },
        activatedAtMs: 13
      })
    }

    store.purge('watcher-1')
    expect(store.facts('watcher-1')).toEqual({
      pin: null,
      outputs: [],
      dispatches: [],
      swarmExpansions: [],
      childWorktrees: [],
      mergeProgress: [],
      composites: []
    })
    expect(store.attemptBaseline('watcher-1', 'watcher-1-fingerprint')).toBeNull()
    expect(store.runSource('watcher-1')).toBeNull()

    const remaining = store.facts('watcher-2')
    expect(remaining.pin).toEqual({ ...pin('shared-ref', 'watcher-2-pipeline'), runNumber: 2 })
    expect(remaining.outputs).toHaveLength(1)
    expect(remaining.outputs).toMatchObject([{ reportSummary: null }])
    expect(remaining.dispatches).toHaveLength(1)
    expect(remaining.swarmExpansions).toHaveLength(1)
    expect(remaining.childWorktrees).toHaveLength(1)
    expect(remaining.mergeProgress).toHaveLength(1)
    expect(remaining.composites).toHaveLength(1)
    expect(store.attemptBaseline('watcher-2', 'watcher-2-fingerprint')).toEqual({
      workspacePath: '/workspace',
      digest: { watcherId: 'watcher-2' }
    })
    expect(store.runSource('watcher-2')).toEqual({ sourceText: 'watcher-2 source' })
  })

  it('reconciles only stale dispatches and baselines, retaining recorded attempts and other facts', () => {
    const store = createInMemoryPipelineStore()
    store.recordNodeOutput({
      watcherId: 'watcher-reconcile',
      instanceId: 'node-a',
      epoch: 3,
      attempt: 1,
      outputs: { preserved: true },
      reportSha256: null,
      nowMs: 1
    })
    store.recordNodeOutput({
      watcherId: 'watcher-reconcile',
      instanceId: 'node-a',
      epoch: 3,
      attempt: 2,
      outputs: { preserved: 'orphan fact' },
      reportSha256: null,
      nowMs: 2
    })
    for (const attempt of [1, 2]) {
      store.recordDispatch({
        watcherId: 'watcher-reconcile',
        instanceId: 'node-a',
        epoch: 3,
        attempt,
        dispatchId: `dispatch-${attempt}`,
        workspaceId: null,
        terminalHandle: null,
        reportPath: `/workspace/report-${attempt}.json`,
        dispatchedAtMs: attempt
      })
    }
    store.recordAttemptBaseline({
      watcherId: 'watcher-reconcile',
      attemptFingerprint: 'recorded-fingerprint',
      workspacePath: '/recorded',
      digest: { recorded: true }
    })
    store.recordAttemptBaseline({
      watcherId: 'watcher-reconcile',
      attemptFingerprint: 'orphan-fingerprint',
      workspacePath: '/orphan',
      digest: { recorded: false }
    })

    store.reconcile('watcher-reconcile', new Set(['node-a:3:1', 'recorded-fingerprint']))

    expect(store.facts('watcher-reconcile').dispatches).toEqual([
      {
        instanceId: 'node-a',
        epoch: 3,
        attempt: 1,
        dispatchId: 'dispatch-1',
        workspaceId: null,
        terminalHandle: null,
        reportPath: '/workspace/report-1.json',
        dispatchedAtMs: 1
      }
    ])
    expect(store.attemptBaseline('watcher-reconcile', 'recorded-fingerprint')).toEqual({
      workspacePath: '/recorded',
      digest: { recorded: true }
    })
    expect(store.attemptBaseline('watcher-reconcile', 'orphan-fingerprint')).toBeNull()
    expect(store.facts('watcher-reconcile').outputs).toHaveLength(2)
  })
})
