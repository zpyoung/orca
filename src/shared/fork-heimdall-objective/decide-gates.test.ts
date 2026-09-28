import { describe, expect, it } from 'vitest'
import { decideObjective } from './decision'
import { decideObjectiveGates } from './decide-gates'
import {
  attempt,
  CONTRACT,
  gate,
  gateAttempt,
  ledger,
  node,
  projection,
  revision,
  snapshot
} from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'

const withGates = (
  gates: ReturnType<typeof gate>[],
  projectionOverrides: Parameters<typeof projection>[0] = {}
) =>
  snapshot(projection({ nodes: [node('core', { state: 'succeeded' })], ...projectionOverrides }), {
    contract: { ...CONTRACT, gates }
  })

describe('decideObjectiveGates', () => {
  it('returns null when no gates are declared', () => {
    expect(decideObjectiveGates(snapshot(projection()), ledger(), [], [], revision())).toBeNull()
    expect(
      decideObjectiveGates(
        snapshot(projection(), { contract: { ...CONTRACT, gates: [] } }),
        ledger(),
        [],
        [],
        revision()
      )
    ).toBeNull()
  })

  it('emits run-gate for the first missing gate, leaving later gates for later ticks', () => {
    const snap = withGates([gate('unit'), gate('full-suite')])
    const decision = decideObjectiveGates(snap, ledger(), [], [], revision())
    expect(decision?.action).toMatchObject({
      kind: 'run-gate',
      capability: 'check',
      visibility: 'local',
      gateName: 'unit',
      command: 'pnpm test',
      timeoutSeconds: 1_800,
      contentIdentity: 'content-current',
      evidenceKey: 'objective-gate:unit:content-current'
    })
  })

  it('treats a passed gate as satisfied and reports the next missing gate', () => {
    const snap = withGates([gate('unit'), gate('full-suite')], {
      gateAttempts: [gateAttempt({ gateName: 'unit' })]
    })
    const decision = decideObjectiveGates(snap, ledger(), [], [], revision())
    expect(decision?.action).toMatchObject({ kind: 'run-gate', gateName: 'full-suite' })
  })

  it('returns null once every declared gate has passed at the current identity', () => {
    const snap = withGates([gate('unit'), gate('full-suite')], {
      gateAttempts: [gateAttempt({ gateName: 'unit' }), gateAttempt({ gateName: 'full-suite' })]
    })
    expect(decideObjectiveGates(snap, ledger(), [], [], revision())).toBeNull()
  })

  it('repairs the approved revision after a failed gate when no owner is configured', () => {
    const snap = withGates([gate('unit')], {
      gateAttempts: [gateAttempt({ gateName: 'unit', exitCode: 1 })]
    })
    const decision = decideObjectiveGates(snap, ledger(), [], [], revision())
    expect(decision?.action).toMatchObject({
      kind: 'dispatch-planner',
      plannerMode: 'repair',
      repairRevisionId: 'revision-1',
      reason: 'replan-after-failure'
    })
  })

  it('raises a check-failed deviation for a failed gate when an owner is configured', () => {
    const snap = withGates([gate('unit')], {
      gateAttempts: [gateAttempt({ gateName: 'unit', exitCode: 3 })]
    })
    const decision = decideObjectiveGates(snap, ledger(), [], [], revision(), true)
    expect(decision).toEqual({
      action: null,
      deviation: {
        kind: 'check-failed',
        criterionId: 'objective-gate:unit',
        command: 'pnpm test',
        exitCode: 3,
        timedOut: false
      }
    })
  })

  it('treats a timed-out completed attempt as a failure even with exit code 0', () => {
    const snap = withGates([gate('unit')], {
      gateAttempts: [gateAttempt({ gateName: 'unit', exitCode: 0, timedOut: true })]
    })
    const decision = decideObjectiveGates(snap, ledger(), [], [], revision(), true)
    expect(decision).toMatchObject({ deviation: { kind: 'check-failed', timedOut: true } })
  })

  it('treats a not-landed gate attempt as a failure with a landing-specific detail', () => {
    const gateAction: ObjectiveAction = {
      kind: 'run-gate',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'objective-gate:unit:content-current',
      gateName: 'unit',
      command: 'pnpm test',
      timeoutSeconds: 1_800
    }
    const attempts = [
      {
        attempt: attempt(gateAction, { state: 'settled', effect: 'not-landed' }),
        action: gateAction
      }
    ]
    const snap = withGates([gate('unit')])
    const decision = decideObjectiveGates(snap, ledger(), attempts, [], revision(), true)
    expect(decision).toMatchObject({
      deviation: {
        kind: 'check-failed',
        criterionId: 'objective-gate:unit',
        detail: 'the gate attempt itself failed to land'
      }
    })
  })

  it('reports the in-flight reason for a running gate attempt', () => {
    const gateAction: ObjectiveAction = {
      kind: 'run-gate',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'objective-gate:unit:content-current',
      gateName: 'unit',
      command: 'pnpm test',
      timeoutSeconds: 1_800
    }
    const attempts = [{ attempt: attempt(gateAction, { state: 'running' }), action: gateAction }]
    const snap = withGates([gate('unit')])
    const decision = decideObjectiveGates(snap, ledger(), attempts, [], revision())
    expect(decision).toMatchObject({ action: null, reason: 'gate-in-flight' })
  })

  it('re-runs a gate whose only completed attempt is at a different content identity', () => {
    const snap = withGates([gate('unit')], {
      gateAttempts: [gateAttempt({ gateName: 'unit', contentIdentity: 'content-stale' })]
    })
    const decision = decideObjectiveGates(snap, ledger(), [], [], revision())
    expect(decision?.action).toMatchObject({
      kind: 'run-gate',
      gateName: 'unit',
      contentIdentity: 'content-current'
    })
  })

  it('picks the first failed gate in declaration order even when an earlier gate is only missing', () => {
    const snap = withGates([gate('unit'), gate('full-suite')], {
      gateAttempts: [gateAttempt({ gateName: 'full-suite', exitCode: 1 })]
    })
    const decision = decideObjectiveGates(snap, ledger(), [], [], revision(), true)
    expect(decision).toMatchObject({
      deviation: { kind: 'check-failed', criterionId: 'objective-gate:full-suite' }
    })
  })

  it('holds gates while a read-only worker is in flight', () => {
    const reviewDispatch: ObjectiveAction = {
      kind: 'dispatch-reviewer',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:plan-digest:review:content-current',
      revisionId: 'revision-1'
    }
    const attempts = [
      {
        attempt: attempt(reviewDispatch, { dispatchId: 'review-dispatch' }),
        action: reviewDispatch
      }
    ]
    const snap = withGates([gate('unit')])
    const decision = decideObjectiveGates(snap, ledger(), attempts, [], revision())
    expect(decision).toMatchObject({ action: null, reason: 'read-only-worker-in-flight' })
  })

  it('re-issues a stale gate attempt with a distinct suffixed evidence key', () => {
    const staleAction: ObjectiveAction = {
      kind: 'run-gate',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'objective-gate:unit:content-current',
      gateName: 'unit',
      command: 'pnpm test',
      timeoutSeconds: 1_800
    }
    const attempts = [
      {
        attempt: attempt(staleAction, {
          state: 'settled',
          effect: 'not-landed',
          reason: 'check-evidence-stale'
        }),
        action: staleAction
      }
    ]
    const snap = withGates([gate('unit')])
    const decision = decideObjectiveGates(snap, ledger(), attempts, [], revision())
    expect(decision?.action).toMatchObject({
      kind: 'run-gate',
      gateName: 'unit',
      contentIdentity: 'content-current',
      evidenceKey: 'objective-gate:unit:content-current#stale-1'
    })
  })

  it('treats a stale gate attempt as an ordinary failure once retries reach the cap', () => {
    const staleEvidenceKeys = [
      'objective-gate:unit:content-current',
      'objective-gate:unit:content-current#stale-1',
      'objective-gate:unit:content-current#stale-2'
    ]
    const attempts = staleEvidenceKeys.map((evidenceKey, index) => {
      const action: ObjectiveAction = {
        kind: 'run-gate',
        capability: 'check',
        visibility: 'local',
        contentIdentity: 'content-current',
        evidenceKey,
        gateName: 'unit',
        command: 'pnpm test',
        timeoutSeconds: 1_800
      }
      return {
        attempt: attempt(action, {
          state: 'settled',
          effect: 'not-landed',
          reason: 'check-evidence-stale',
          dispatchId: `stale-${index}`
        }),
        action
      }
    })
    const snap = withGates([gate('unit')])
    const decision = decideObjectiveGates(snap, ledger(), attempts, [], revision(), true)
    expect(decision).toMatchObject({
      deviation: {
        kind: 'check-failed',
        criterionId: 'objective-gate:unit',
        detail: 'the gate attempt itself failed to land'
      }
    })
  })
})

describe('objective gates run between checks and review', () => {
  it('dispatches the first missing gate instead of the reviewer once checks pass', () => {
    const plan = projection({ nodes: [node('core', { state: 'succeeded' })] })
    const decision = decideObjective(
      snapshot(plan, { contract: { ...CONTRACT, gates: [gate('full-suite')] } }),
      ledger()
    )
    expect(decision.action).toMatchObject({ kind: 'run-gate', gateName: 'full-suite' })
  })

  it('still repairs on a check failure ahead of any declared gate', () => {
    const checked = node('core', {
      state: 'succeeded',
      criteria: [
        {
          id: 'criterion-1',
          ordinal: 0,
          body: 'The focused check passes.',
          shellCheckable: true,
          checkCommand: 'pnpm check',
          lastCheck: { contentIdentity: 'content-current', exitCode: 1, timedOut: false, atMs: 50 },
          lastReview: null
        }
      ]
    })
    const decision = decideObjective(
      snapshot(projection({ nodes: [checked] }), {
        contract: { ...CONTRACT, gates: [gate('full-suite')] }
      }),
      ledger()
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      plannerMode: 'repair',
      repairRevisionId: 'revision-1',
      reason: 'replan-after-failure'
    })
  })
})
