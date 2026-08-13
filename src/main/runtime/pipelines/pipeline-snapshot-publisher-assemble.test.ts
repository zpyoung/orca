import { describe, expect, it } from 'vitest'
import type {
  PipelineAttemptRow,
  PipelineNodeRow,
  PipelineRunRow
} from '../orchestration/pipeline-run-db'
import {
  assemblePipelineSnapshot,
  type PipelineSnapshotSource
} from './pipeline-snapshot-publisher-assemble'

function runRow(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
  return {
    run_id: 'run_1',
    template_name: 'bugfix-fast',
    template_version: 1,
    run_number: 4,
    needs_newer_orca: 0,
    state: 'running',
    failure_reason: null,
    input_text: 'bug',
    snapshot_json: JSON.stringify({
      templateName: 'bugfix-fast',
      templateVersion: 1,
      needsNewerOrca: false,
      inputText: 'bug',
      nodes: [
        { id: 'repro', title: 'Reproduce', prompt: '', index: 0, needs: [], harness: 'claude' },
        {
          id: 'fix',
          title: 'Fix',
          prompt: '',
          index: 1,
          needs: ['repro'],
          harness: 'claude',
          limits: { maxMinutes: 20 }
        }
      ]
    }),
    workspace_id: 'w1',
    workspace_display_name: 'my-workspace',
    base_commit: 'abc123',
    branch: 'pipeline/bugfix-fast-4',
    run_worktree_id: 'wt1',
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    ended_at: null,
    ...overrides
  }
}

function nodeRow(overrides: Partial<PipelineNodeRow>): PipelineNodeRow {
  return {
    run_id: 'run_1',
    node_id: 'repro',
    node_index: 0,
    task_id: 'task_1',
    title: 'Reproduce',
    retries_allowed: 1,
    outcome: null,
    outcome_reason: null,
    prelaunch_failures: 0,
    ...overrides
  }
}

function attemptRow(overrides: Partial<PipelineAttemptRow>): PipelineAttemptRow {
  return {
    run_id: 'run_1',
    node_id: 'repro',
    attempt: 1,
    dispatch_id: 'dispatch_1',
    checkpoint_head: 'head1',
    checkpoint_snapshot: 'head1',
    checkpoint_ref: 'refs/orca/pipeline/run_1/repro-1',
    started_at: '2026-08-12T00:00:00.000Z',
    ended_at: null,
    outcome: null,
    failure_stage: null,
    ...overrides
  }
}

function sourceOf(
  run: PipelineRunRow | undefined,
  nodes: PipelineNodeRow[],
  attempts: PipelineAttemptRow[]
): PipelineSnapshotSource {
  return {
    getPipelineRun: () => run,
    getNodes: () => nodes,
    getAttempts: () => attempts
  }
}

describe('assemblePipelineSnapshot', () => {
  it('returns a minimal wire payload when the run is unknown', () => {
    const snapshot = assemblePipelineSnapshot(sourceOf(undefined, [], []), 'run_missing')
    expect(snapshot.runId).toBe('run_missing')
    expect(snapshot.nodes).toBeUndefined()
    expect(snapshot.state).toBeUndefined()
  })

  it('carries run identity fields verbatim from the row', () => {
    const source = sourceOf(runRow(), [nodeRow({})], [])
    const snapshot = assemblePipelineSnapshot(source, 'run_1')
    expect(snapshot.runId).toBe('run_1')
    expect(snapshot.templateName).toBe('bugfix-fast')
    expect(snapshot.runNumber).toBe(4)
    expect(snapshot.needsNewerOrca).toBe(false)
    expect(snapshot.state).toBe('running')
  })

  it('maps needs_newer_orca=1 to true', () => {
    const source = sourceOf(runRow({ needs_newer_orca: 1 }), [], [])
    const snapshot = assemblePipelineSnapshot(source, 'run_1')
    expect(snapshot.needsNewerOrca).toBe(true)
  })

  it('waiting: never dispatched, run live', () => {
    const source = sourceOf(runRow({ state: 'running' }), [nodeRow({ node_id: 'fix' })], [])
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.status).toBe('waiting')
  })

  it('held: never dispatched, run paused', () => {
    const source = sourceOf(runRow({ state: 'paused' }), [nodeRow({ node_id: 'fix' })], [])
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.status).toBe('held')
  })

  it('running: dispatched, in flight, no prior failure', () => {
    const source = sourceOf(
      runRow({ state: 'running' }),
      [nodeRow({ node_id: 'repro' })],
      [attemptRow({ attempt: 1, ended_at: null, outcome: null })]
    )
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.status).toBe('running')
    expect(node?.attempt).toBe(1)
  })

  it('retrying: a prior failed attempt exists and the run is live', () => {
    const source = sourceOf(
      runRow({ state: 'running' }),
      [nodeRow({ node_id: 'repro', retries_allowed: 1 })],
      [
        attemptRow({ attempt: 1, ended_at: '2026-08-12T00:01:00.000Z', outcome: 'failed' }),
        attemptRow({ attempt: 2, ended_at: null, outcome: null })
      ]
    )
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.status).toBe('retrying')
    expect(node?.attempt).toBe(2)
    expect(node?.attemptsAllowed).toBe(2)
  })

  it('succeeded: node outcome recorded succeeded, regardless of run phase', () => {
    const source = sourceOf(
      runRow({ state: 'running' }),
      [nodeRow({ node_id: 'repro', outcome: 'succeeded' })],
      [attemptRow({ attempt: 1, ended_at: '2026-08-12T00:01:00.000Z', outcome: 'succeeded' })]
    )
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.status).toBe('succeeded')
  })

  it('failed: node outcome recorded failed once retries are exhausted', () => {
    const source = sourceOf(
      runRow({ state: 'failed' }),
      [nodeRow({ node_id: 'repro', outcome: 'failed', outcome_reason: 'exhausted' })],
      [attemptRow({ attempt: 1, ended_at: '2026-08-12T00:01:00.000Z', outcome: 'failed' })]
    )
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.status).toBe('failed')
  })

  it('not_run: never dispatched, run reached a terminal state', () => {
    const source = sourceOf(runRow({ state: 'failed' }), [nodeRow({ node_id: 'fix' })], [])
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.status).toBe('not_run')
  })

  it('interrupted: begun with no terminal outcome once the run is terminal', () => {
    const source = sourceOf(
      runRow({ state: 'interrupted' }),
      [nodeRow({ node_id: 'repro' })],
      [attemptRow({ attempt: 1, ended_at: null, outcome: null })]
    )
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.status).toBe('interrupted')
  })

  it('running: a stage-B prelaunch cycle in progress creates no attempt row but counts as dispatched', () => {
    const source = sourceOf(
      runRow({ state: 'running' }),
      [nodeRow({ node_id: 'repro', prelaunch_failures: 1 })],
      []
    )
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.status).toBe('running')
  })

  it('interrupted: a node that only ever had prelaunch cycles renders interrupted once the run is terminal', () => {
    const source = sourceOf(
      runRow({ state: 'aborted' }),
      [nodeRow({ node_id: 'repro', prelaunch_failures: 2 })],
      []
    )
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.status).toBe('interrupted')
  })

  it('computes limitBreached from the snapshot definition and elapsed time', () => {
    const source = sourceOf(
      runRow({ state: 'running' }),
      [nodeRow({ node_id: 'fix', retries_allowed: 0 })],
      [attemptRow({ node_id: 'fix', attempt: 1, started_at: '2026-08-12T00:00:00.000Z', ended_at: null })]
    )
    const now = new Date('2026-08-12T00:25:00.000Z')
    const node = assemblePipelineSnapshot(source, 'run_1', { now }).nodes?.[0]
    expect(node?.limitMinutes).toBe(20)
    expect(node?.limitBreached).toBe(true)
  })

  it('does not flag limitBreached before the advisory limit elapses', () => {
    const source = sourceOf(
      runRow({ state: 'running' }),
      [nodeRow({ node_id: 'fix', retries_allowed: 0 })],
      [attemptRow({ node_id: 'fix', attempt: 1, started_at: '2026-08-12T00:00:00.000Z', ended_at: null })]
    )
    const now = new Date('2026-08-12T00:05:00.000Z')
    const node = assemblePipelineSnapshot(source, 'run_1', { now }).nodes?.[0]
    expect(node?.limitBreached).toBe(false)
  })

  it('keeps limitBreached true after the attempt ends, using its actual elapsed duration', () => {
    const source = sourceOf(
      runRow({ state: 'completed' }),
      [nodeRow({ node_id: 'fix', retries_allowed: 0, outcome: 'succeeded' })],
      [
        attemptRow({
          node_id: 'fix',
          attempt: 1,
          started_at: '2026-08-12T00:00:00.000Z',
          ended_at: '2026-08-12T00:25:00.000Z',
          outcome: 'succeeded'
        })
      ]
    )
    const node = assemblePipelineSnapshot(source, 'run_1', {
      now: new Date('2026-08-12T01:00:00.000Z')
    }).nodes?.[0]
    expect(node?.limitBreached).toBe(true)
  })

  it('does not flag limitBreached when the attempt ended within the advisory limit', () => {
    const source = sourceOf(
      runRow({ state: 'completed' }),
      [nodeRow({ node_id: 'fix', retries_allowed: 0, outcome: 'succeeded' })],
      [
        attemptRow({
          node_id: 'fix',
          attempt: 1,
          started_at: '2026-08-12T00:00:00.000Z',
          ended_at: '2026-08-12T00:10:00.000Z',
          outcome: 'succeeded'
        })
      ]
    )
    const node = assemblePipelineSnapshot(source, 'run_1', {
      now: new Date('2026-08-12T01:00:00.000Z')
    }).nodes?.[0]
    expect(node?.limitBreached).toBe(false)
  })

  it('carries each node dependency list from the snapshot definition', () => {
    const source = sourceOf(
      runRow(),
      [nodeRow({ node_id: 'repro' }), nodeRow({ node_id: 'fix', node_index: 1 })],
      []
    )
    const snapshot = assemblePipelineSnapshot(source, 'run_1')
    expect(snapshot.nodes?.find((n) => n.id === 'repro')?.needs).toEqual([])
    expect(snapshot.nodes?.find((n) => n.id === 'fix')?.needs).toEqual(['repro'])
  })

  it('omits needs for a node absent from the snapshot definition', () => {
    const source = sourceOf(runRow(), [nodeRow({ node_id: 'orphan' })], [])
    const node = assemblePipelineSnapshot(source, 'run_1').nodes?.[0]
    expect(node?.needs).toBeUndefined()
  })

  it('carries the pausing annotation when supplied', () => {
    const source = sourceOf(runRow({ state: 'paused' }), [], [])
    const snapshot = assemblePipelineSnapshot(source, 'run_1', { pausing: true })
    expect(snapshot.pausing).toBe(true)
  })

  it('omits the pausing annotation when not requested', () => {
    const source = sourceOf(runRow({ state: 'paused' }), [], [])
    const snapshot = assemblePipelineSnapshot(source, 'run_1')
    expect(snapshot.pausing).toBeUndefined()
  })

  it('is a complete snapshot: identical inputs produce identical full output on repeat calls', () => {
    const source = sourceOf(
      runRow({ state: 'running' }),
      [nodeRow({ node_id: 'repro' })],
      [attemptRow({ attempt: 1 })]
    )
    const first = assemblePipelineSnapshot(source, 'run_1', { now: new Date('2026-08-12T00:00:01Z') })
    const second = assemblePipelineSnapshot(source, 'run_1', { now: new Date('2026-08-12T00:00:01Z') })
    expect(second).toEqual(first)
  })
})
