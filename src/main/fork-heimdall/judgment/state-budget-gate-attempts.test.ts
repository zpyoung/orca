import { describe, expect, it } from 'vitest'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import { ledger, world as buildWorld } from './judgment-test-world'
import { projectBoundedJudgmentState, type JudgmentState } from './state-budget'

type GateAttempt = NonNullable<ObjectiveWorld['plan']['gateAttempts']>[number]

function gate(
  gateName: string,
  contentIdentity: string,
  completedAtMs: number | null,
  fill: string
): GateAttempt {
  return {
    gateName,
    contentIdentity,
    executionHostId: 'host-1',
    command: `pnpm ${gateName}`,
    exitCode: completedAtMs === null ? null : 1,
    timedOut: completedAtMs === null ? null : false,
    stdoutTail: completedAtMs === null ? null : fill.repeat(4_000),
    stderrTail: null,
    startedAtMs: 1,
    completedAtMs
  }
}

// content-live landed from content-base, so gates keyed to content-base are still the live gates
function gateWorld(): ObjectiveWorld {
  const current = buildWorld({ withCapabilities: true })
  current.plan.landing = [
    {
      rung: 'committed-local-branch',
      revisionId: 'revision-live',
      contentIdentity: 'content-live',
      fromContentIdentity: 'content-base',
      atMs: 30
    }
  ]
  current.plan.gateAttempts = [
    gate('stale-old', 'content-a', 10, 'a'),
    gate('stale-new', 'content-b', 20, 'b'),
    gate('live', 'content-live', 5, 'c'),
    gate('in-flight', 'content-a', null, 'e'),
    gate('lineage', 'content-base', 3, 'd')
  ]
  return current
}

function project(maxStateBytes?: number) {
  return projectBoundedJudgmentState('content-live', gateWorld(), ledger('gate-watcher', []), {
    maxStateBytes,
    normalize: false
  })
}

function retainedGateNames(state: unknown): string[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: normalize:false returns the unencoded JudgmentState whose plan keeps the objective plan shape.
  const plan = (state as JudgmentState).objective.plan as ObjectiveWorld['plan']
  return (plan.gateAttempts ?? []).map((attempt) => attempt.gateName)
}

describe('stale gate attempt omission', () => {
  it('drops the oldest stale-content gate attempt first and keeps live and in-flight gates', () => {
    const full = project()
    const bounded = project(full.serializedBytes - 1)

    expect(bounded.fitsStateBudget).toBe(true)
    expect(retainedGateNames(bounded.state)).toEqual(['stale-new', 'live', 'in-flight', 'lineage'])
    expect(bounded.truncation?.omitted.gateAttempts).toBe(1)
    expect(bounded.truncationNotice).toContain('1 stale gate attempt(s)')
  })

  it('never drops gates for the current or lineage-base content even when the state cannot fit', () => {
    const bounded = project(1_000)

    expect(bounded.fitsStateBudget).toBe(false)
    expect(retainedGateNames(bounded.state)).toEqual(['live', 'in-flight', 'lineage'])
    expect(bounded.truncation?.omitted.gateAttempts).toBe(2)
  })
})
