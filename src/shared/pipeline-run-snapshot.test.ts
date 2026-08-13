import { describe, expect, it } from 'vitest'

import {
  decodePipelineNodeStatus,
  decodePipelineRunSnapshotWire,
  decodePipelineRunState,
  derivePipelineNodeStatus,
  type PipelineNodeObservables,
  type PipelineNodeStatus
} from './pipeline-run-snapshot'

type Case = { desc: string; o: PipelineNodeObservables; expected: PipelineNodeStatus }

const RUN_PHASES = ['live', 'paused', 'terminal'] as const
const BOOLS = [false, true] as const

function cases(): Case[] {
  const out: Case[] = []

  for (const terminalOutcome of ['succeeded', 'failed'] as const) {
    for (const everDispatched of BOOLS) {
      for (const attemptInFlight of BOOLS) {
        for (const priorFailedAttempt of BOOLS) {
          for (const runPhase of RUN_PHASES) {
            out.push({
              desc: `T=${terminalOutcome} E=${everDispatched} F=${attemptInFlight} H=${priorFailedAttempt} R=${runPhase} -> ${terminalOutcome}`,
              o: { terminalOutcome, everDispatched, attemptInFlight, priorFailedAttempt, runPhase },
              expected: terminalOutcome
            })
          }
        }
      }
    }
  }

  for (const attemptInFlight of BOOLS) {
    for (const priorFailedAttempt of BOOLS) {
      out.push({
        desc: `T=null E=true F=${attemptInFlight} H=${priorFailedAttempt} R=terminal -> interrupted`,
        o: {
          terminalOutcome: null,
          everDispatched: true,
          attemptInFlight,
          priorFailedAttempt,
          runPhase: 'terminal'
        },
        expected: 'interrupted'
      })
      out.push({
        desc: `T=null E=false F=${attemptInFlight} H=${priorFailedAttempt} R=terminal -> not_run`,
        o: {
          terminalOutcome: null,
          everDispatched: false,
          attemptInFlight,
          priorFailedAttempt,
          runPhase: 'terminal'
        },
        expected: 'not_run'
      })
    }
  }

  for (const runPhase of ['live', 'paused'] as const) {
    for (const attemptInFlight of BOOLS) {
      out.push({
        desc: `T=null E=true F=${attemptInFlight} H=true R=${runPhase} -> retrying`,
        o: {
          terminalOutcome: null,
          everDispatched: true,
          attemptInFlight,
          priorFailedAttempt: true,
          runPhase
        },
        expected: 'retrying'
      })
    }
    out.push({
      desc: `T=null E=true F=true H=false R=${runPhase} -> running`,
      o: {
        terminalOutcome: null,
        everDispatched: true,
        attemptInFlight: true,
        priorFailedAttempt: false,
        runPhase
      },
      expected: 'running'
    })
  }

  out.push({
    desc: 'T=null E=false F=false H=false R=paused -> held',
    o: {
      terminalOutcome: null,
      everDispatched: false,
      attemptInFlight: false,
      priorFailedAttempt: false,
      runPhase: 'paused'
    },
    expected: 'held'
  })
  out.push({
    desc: 'T=null E=false F=false H=false R=live -> waiting',
    o: {
      terminalOutcome: null,
      everDispatched: false,
      attemptInFlight: false,
      priorFailedAttempt: false,
      runPhase: 'live'
    },
    expected: 'waiting'
  })

  return out
}

describe('derivePipelineNodeStatus — C6 totality table', () => {
  it.each(cases())('$desc', ({ o, expected }) => {
    expect(derivePipelineNodeStatus(o)).toBe(expected)
  })

  it('H distinguishes running from retrying under identical (T, E, F, R)', () => {
    const base = {
      terminalOutcome: null,
      everDispatched: true,
      attemptInFlight: true,
      runPhase: 'live'
    } as const

    expect(derivePipelineNodeStatus({ ...base, priorFailedAttempt: false })).toBe('running')
    expect(derivePipelineNodeStatus({ ...base, priorFailedAttempt: true })).toBe('retrying')
  })

  it('an L16a stage-A rejection renders failed, not not_run, though never dispatched', () => {
    expect(
      derivePipelineNodeStatus({
        terminalOutcome: 'failed',
        everDispatched: false,
        attemptInFlight: false,
        priorFailedAttempt: false,
        runPhase: 'terminal'
      })
    ).toBe('failed')
  })

  it('retrying beats running and held', () => {
    expect(
      derivePipelineNodeStatus({
        terminalOutcome: null,
        everDispatched: true,
        attemptInFlight: true,
        priorFailedAttempt: true,
        runPhase: 'live'
      })
    ).toBe('retrying')
    expect(
      derivePipelineNodeStatus({
        terminalOutcome: null,
        everDispatched: true,
        attemptInFlight: false,
        priorFailedAttempt: true,
        runPhase: 'paused'
      })
    ).toBe('retrying')
  })

  it('held beats waiting', () => {
    expect(
      derivePipelineNodeStatus({
        terminalOutcome: null,
        everDispatched: false,
        attemptInFlight: false,
        priorFailedAttempt: false,
        runPhase: 'paused'
      })
    ).toBe('held')
  })
})

describe('decodePipelineNodeStatus', () => {
  it('decodes every known tag to itself', () => {
    const known: PipelineNodeStatus[] = [
      'waiting',
      'running',
      'retrying',
      'succeeded',
      'failed',
      'not_run',
      'held',
      'interrupted'
    ]
    for (const tag of known) {
      expect(decodePipelineNodeStatus(tag)).toBe(tag)
    }
  })

  it('returns unknown for unrecognized or absent tags without throwing', () => {
    expect(() => decodePipelineNodeStatus('some-future-status')).not.toThrow()
    expect(decodePipelineNodeStatus('some-future-status')).toBe('unknown')
    expect(decodePipelineNodeStatus(undefined)).toBe('unknown')
    expect(decodePipelineNodeStatus('')).toBe('unknown')
  })
})

describe('decodePipelineRunState', () => {
  it('decodes every known tag to itself', () => {
    const known = [
      'setup',
      'running',
      'paused',
      'completed',
      'failed',
      'aborted',
      'interrupted'
    ] as const
    for (const tag of known) {
      expect(decodePipelineRunState(tag)).toBe(tag)
    }
  })

  it('returns unknown for unrecognized or absent tags without throwing', () => {
    expect(() => decodePipelineRunState('some-future-state')).not.toThrow()
    expect(decodePipelineRunState('some-future-state')).toBe('unknown')
    expect(decodePipelineRunState(undefined)).toBe('unknown')
  })
})

describe('decodePipelineRunSnapshotWire', () => {
  it('passes through a well-formed snapshot unchanged', () => {
    const raw = {
      runId: 'run_1',
      templateName: 'bugfix-fast',
      runNumber: 4,
      state: 'running',
      nodes: [{ id: 'repro', status: 'running', attempt: 1, needs: [] }]
    }
    expect(decodePipelineRunSnapshotWire(raw)).toEqual(raw)
  })

  it('rejects a payload with no string runId', () => {
    expect(decodePipelineRunSnapshotWire({ nodes: [] })).toBeNull()
    expect(decodePipelineRunSnapshotWire({ runId: 42 })).toBeNull()
    expect(decodePipelineRunSnapshotWire(null)).toBeNull()
    expect(decodePipelineRunSnapshotWire('run_1')).toBeNull()
    expect(decodePipelineRunSnapshotWire(undefined)).toBeNull()
  })

  it('drops a non-array nodes field instead of throwing or forwarding it', () => {
    expect(() => decodePipelineRunSnapshotWire({ runId: 'run_1', nodes: {} })).not.toThrow()
    const decoded = decodePipelineRunSnapshotWire({ runId: 'run_1', nodes: { 0: { id: 'repro' } } })
    expect(decoded).toEqual({ runId: 'run_1' })
  })

  it('drops a node missing a string id rather than passing a broken entry through', () => {
    const decoded = decodePipelineRunSnapshotWire({
      runId: 'run_1',
      nodes: [{ status: 'running' }, { id: 'fix', status: 'waiting' }]
    })
    expect(decoded?.nodes).toEqual([{ id: 'fix', status: 'waiting' }])
  })

  it('drops a wrong-typed attempt field but keeps the rest of the node', () => {
    const decoded = decodePipelineRunSnapshotWire({
      runId: 'run_1',
      nodes: [{ id: 'fix', status: 'running', attempt: 'two' }]
    })
    expect(decoded?.nodes).toEqual([{ id: 'fix', status: 'running' }])
  })

  it('drops a needs array containing non-string entries', () => {
    const decoded = decodePipelineRunSnapshotWire({
      runId: 'run_1',
      nodes: [{ id: 'fix', needs: ['repro', 7] }]
    })
    expect(decoded?.nodes).toEqual([{ id: 'fix' }])
  })

  it('drops a wrong-typed top-level field but keeps the rest of the snapshot', () => {
    const decoded = decodePipelineRunSnapshotWire({ runId: 'run_1', runNumber: 'four', state: 'running' })
    expect(decoded).toEqual({ runId: 'run_1', state: 'running' })
  })
})
