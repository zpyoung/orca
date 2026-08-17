import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PipelineAttemptRow,
  PipelineNodeRow,
  PipelineRunRow
} from '../orchestration/pipeline-run-db'
import type { PipelineRunSnapshotWire } from '../../../shared/pipeline-run-snapshot'
import { PipelineSnapshotPublisher } from './pipeline-snapshot-publisher'
import type { PipelineSnapshotSource } from './pipeline-snapshot-publisher-assemble'

function runRow(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
  return {
    run_id: 'run_1',
    template_name: 'bugfix-fast',
    template_version: 1,
    run_number: 1,
    needs_newer_orca: 0,
    state: 'running',
    failure_reason: null,
    input_text: 'bug',
    snapshot_json: JSON.stringify({ nodes: [] }),
    workspace_id: 'w1',
    workspace_display_name: 'my-workspace',
    base_commit: 'abc',
    branch: 'pipeline/bugfix-fast-1',
    run_worktree_id: 'wt1',
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    ended_at: null,
    ...overrides
  }
}

/** A mutable in-memory stand-in for `PipelineRunDb`, so the publisher can be driven directly. */
class FakeSource implements PipelineSnapshotSource {
  private runsById = new Map<string, PipelineRunRow>()
  private nodesById = new Map<string, PipelineNodeRow[]>()
  private attemptsById = new Map<string, PipelineAttemptRow[]>()

  setRun(row: PipelineRunRow): void {
    this.runsById.set(row.run_id, row)
  }

  setNodes(runId: string, rows: PipelineNodeRow[]): void {
    this.nodesById.set(runId, rows)
  }

  setAttempts(runId: string, rows: PipelineAttemptRow[]): void {
    this.attemptsById.set(runId, rows)
  }

  getPipelineRun(runId: string): PipelineRunRow | undefined {
    return this.runsById.get(runId)
  }

  getNodes(runId: string): PipelineNodeRow[] {
    return this.nodesById.get(runId) ?? []
  }

  getAttempts(runId: string): PipelineAttemptRow[] {
    return this.attemptsById.get(runId) ?? []
  }
}

describe('PipelineSnapshotPublisher', () => {
  let source: FakeSource
  let publisher: PipelineSnapshotPublisher

  beforeEach(() => {
    vi.useFakeTimers()
    source = new FakeSource()
    publisher = new PipelineSnapshotPublisher(source)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers the current snapshot synchronously on subscribe, before anything else', () => {
    source.setRun(runRow({ state: 'running' }))
    const received: PipelineRunSnapshotWire[] = []
    publisher.subscribe('run_1', (snapshot) => received.push(snapshot))

    expect(received).toHaveLength(1)
    expect(received[0].runId).toBe('run_1')
    expect(received[0].state).toBe('running')
  })

  it('delivers the on-subscribe snapshot even for a run already in a terminal state', () => {
    source.setRun(runRow({ state: 'completed' }))
    const received: PipelineRunSnapshotWire[] = []
    publisher.subscribe('run_1', (snapshot) => received.push(snapshot))

    expect(received).toHaveLength(1)
    expect(received[0].state).toBe('completed')
  })

  it('emits no heartbeat for a run already terminal at subscribe time', () => {
    source.setRun(runRow({ state: 'completed' }))
    const received: PipelineRunSnapshotWire[] = []
    publisher.subscribe('run_1', (snapshot) => received.push(snapshot))

    vi.advanceTimersByTime(30_000)
    expect(received).toHaveLength(1)
  })

  it('heartbeats at least every 5 seconds while the run is live', () => {
    source.setRun(runRow({ state: 'running' }))
    const received: PipelineRunSnapshotWire[] = []
    publisher.subscribe('run_1', (snapshot) => received.push(snapshot))

    expect(received).toHaveLength(1)
    vi.advanceTimersByTime(4_999)
    expect(received).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(received).toHaveLength(2)
    vi.advanceTimersByTime(5_000)
    expect(received).toHaveLength(3)
    vi.advanceTimersByTime(5_000)
    expect(received).toHaveLength(4)
  })

  it('heartbeats even when nothing changed between ticks', () => {
    source.setRun(runRow({ state: 'paused' }))
    const received: PipelineRunSnapshotWire[] = []
    publisher.subscribe('run_1', (snapshot) => received.push(snapshot))

    vi.advanceTimersByTime(5_000)
    vi.advanceTimersByTime(5_000)
    expect(received).toHaveLength(3)
    expect(received.every((snapshot) => snapshot.state === 'paused')).toBe(true)
  })

  it('emits exactly one final snapshot at the terminal transition and stops heartbeating', () => {
    source.setRun(runRow({ state: 'running' }))
    const received: PipelineRunSnapshotWire[] = []
    publisher.subscribe('run_1', (snapshot) => received.push(snapshot))
    expect(received).toHaveLength(1)

    source.setRun(runRow({ state: 'completed' }))
    publisher.publish('run_1')
    expect(received).toHaveLength(2)
    expect(received[1].state).toBe('completed')

    vi.advanceTimersByTime(30_000)
    expect(received).toHaveLength(2)
  })

  it('stops delivering to an unsubscribed listener and leaks no timer', () => {
    source.setRun(runRow({ state: 'running' }))
    const received: PipelineRunSnapshotWire[] = []
    const unsubscribe = publisher.subscribe('run_1', (snapshot) => received.push(snapshot))

    vi.advanceTimersByTime(5_000)
    expect(received).toHaveLength(2)

    unsubscribe()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(30_000)
    expect(received).toHaveLength(2)
  })

  it('unsubscribing one of several listeners leaves the others receiving heartbeats', () => {
    source.setRun(runRow({ state: 'running' }))
    const receivedA: PipelineRunSnapshotWire[] = []
    const receivedB: PipelineRunSnapshotWire[] = []
    const unsubscribeA = publisher.subscribe('run_1', (snapshot) => receivedA.push(snapshot))
    publisher.subscribe('run_1', (snapshot) => receivedB.push(snapshot))

    unsubscribeA()
    vi.advanceTimersByTime(5_000)

    expect(receivedA).toHaveLength(1)
    expect(receivedB).toHaveLength(2)
  })

  it('every emission is a complete snapshot, not a delta', () => {
    source.setRun(runRow({ state: 'running' }))
    source.setNodes('run_1', [
      {
        run_id: 'run_1',
        node_id: 'repro',
        node_index: 0,
        task_id: 'task_1',
        title: 'Reproduce',
        retries_allowed: 0,
        outcome: null,
        outcome_reason: null,
        prelaunch_failures: 0
      }
    ])
    const received: PipelineRunSnapshotWire[] = []
    publisher.subscribe('run_1', (snapshot) => received.push(snapshot))

    source.setAttempts('run_1', [
      {
        run_id: 'run_1',
        node_id: 'repro',
        attempt: 1,
        dispatch_id: 'd1',
        checkpoint_head: 'h1',
        checkpoint_snapshot: 'h1',
        checkpoint_ref: 'ref1',
        started_at: '2026-08-12T00:00:00.000Z',
        ended_at: null,
        outcome: null,
        failure_stage: null
      }
    ])
    publisher.publish('run_1')

    expect(received[0].nodes).toHaveLength(1)
    expect(received[0].nodes?.[0].status).toBe('waiting')
    expect(received[1].nodes).toHaveLength(1)
    expect(received[1].nodes?.[0].status).toBe('running')
    expect(received[1].runId).toBe('run_1')
    expect(received[1].templateName).toBe('bugfix-fast')
  })

  it('does not start a heartbeat for a run in setup state', () => {
    source.setRun(runRow({ state: 'setup' }))
    const received: PipelineRunSnapshotWire[] = []
    publisher.subscribe('run_1', (snapshot) => received.push(snapshot))

    vi.advanceTimersByTime(30_000)
    expect(received).toHaveLength(1)
  })

  it('starts heartbeating once a subscribed run transitions from setup to running', () => {
    source.setRun(runRow({ state: 'setup' }))
    const received: PipelineRunSnapshotWire[] = []
    publisher.subscribe('run_1', (snapshot) => received.push(snapshot))
    expect(received).toHaveLength(1)

    source.setRun(runRow({ state: 'running' }))
    publisher.publish('run_1')
    expect(received).toHaveLength(2)

    vi.advanceTimersByTime(5_000)
    expect(received).toHaveLength(3)
  })

  it('carries a pausing annotation set on the publisher into the next assembly', () => {
    source.setRun(runRow({ state: 'paused' }))
    const received: PipelineRunSnapshotWire[] = []
    publisher.subscribe('run_1', (snapshot) => received.push(snapshot))
    expect(received[0].pausing).toBeUndefined()

    publisher.setPausingAnnotation('run_1', true)
    publisher.publish('run_1')
    expect(received[1].pausing).toBe(true)
  })

  describe('a subscriber that throws', () => {
    it('does not stop publish from delivering to the other subscribers, or from returning', () => {
      source.setRun(runRow({ state: 'running' }))
      const receivedGood: PipelineRunSnapshotWire[] = []
      publisher.subscribe('run_1', () => {
        throw new Error('renderer disconnected mid-emit')
      })
      publisher.subscribe('run_1', (snapshot) => receivedGood.push(snapshot))
      expect(receivedGood).toHaveLength(1)

      expect(() => publisher.publish('run_1')).not.toThrow()

      expect(receivedGood).toHaveLength(2)
    })

    it('does not stop the heartbeat timer from continuing to fire and deliver to a well-behaved peer', () => {
      source.setRun(runRow({ state: 'running' }))
      const receivedGood: PipelineRunSnapshotWire[] = []
      publisher.subscribe('run_1', () => {
        throw new Error('boom')
      })
      publisher.subscribe('run_1', (snapshot) => receivedGood.push(snapshot))

      expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
      expect(receivedGood).toHaveLength(2)
      expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
      expect(receivedGood).toHaveLength(3)
    })

    it('drops a subscriber after repeated failures instead of retrying it forever', () => {
      source.setRun(runRow({ state: 'running' }))
      const throwing = vi.fn(() => {
        throw new Error('boom')
      })
      // on-attach emit is failure 1
      publisher.subscribe('run_1', throwing)
      publisher.publish('run_1') // failure 2
      publisher.publish('run_1') // failure 3 -> evicted
      const callsAtEviction = throwing.mock.calls.length

      publisher.publish('run_1')

      expect(throwing.mock.calls.length).toBe(callsAtEviction)
    })

    it('resets the failure count on a successful emit, so an occasional throw never accumulates toward eviction', () => {
      source.setRun(runRow({ state: 'running' }))
      let shouldThrow = true
      const flaky = vi.fn(() => {
        if (shouldThrow) {
          throw new Error('boom')
        }
      })
      publisher.subscribe('run_1', flaky) // failure 1 (call 1)
      publisher.publish('run_1') // failure 2 (call 2)
      shouldThrow = false
      publisher.publish('run_1') // success, resets the count (call 3)
      shouldThrow = true
      publisher.publish('run_1') // failure 1 again (call 4)
      publisher.publish('run_1') // failure 2 again (call 5)
      expect(flaky.mock.calls.length).toBe(5)

      publisher.publish('run_1') // failure 3 -> evicted now (call 6)
      const callsAtEviction = flaky.mock.calls.length
      publisher.publish('run_1')

      expect(flaky.mock.calls.length).toBe(callsAtEviction)
    })
  })
})
