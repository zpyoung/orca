import { describe, expect, it } from 'vitest'
import type { EvidenceEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import {
  computeJudgmentIdentity,
  type ComputedJudgmentIdentity,
  type JudgmentState
} from './identity'
import { ledger as buildLedger, world as buildWorld } from './judgment-test-world'
import { expandJudgmentState } from './state-normalization'

const watcherId = 'budget-watcher'

function world(): ObjectiveWorld {
  return buildWorld({ withCapabilities: true })
}

function ledger(entries: WatcherLedger['entries']): WatcherLedger {
  return buildLedger(watcherId, entries)
}

function expanded(result: ComputedJudgmentIdentity): JudgmentState {
  return expandJudgmentState<JudgmentState>(result.state)
}

function attempt(input: {
  id: string
  evidenceKey: string
  dispatchId: string
  atMs: number
  state?: 'running' | 'settled'
  revisionId?: string
  reason?: string
}): WatcherLedger['entries'][number] {
  const state = input.state ?? 'settled'
  return {
    eventId: `event-${input.id}`,
    watcherId,
    atMs: input.atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: input.id,
    fingerprint: `fingerprint-${input.id}`,
    action: {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: input.evidenceKey,
      ...(input.revisionId ? { revisionId: input.revisionId } : {})
    },
    state,
    ...(state === 'settled' ? { effect: 'not-landed' as const } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    dispatchId: input.dispatchId
  }
}

function mailboxReport(dispatchId: string, body: string, atMs = 10): EvidenceEntry {
  return {
    eventId: `report-${dispatchId}`,
    watcherId,
    atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      body,
      payload: { dispatchId, outcome: 'succeeded' }
    }
  }
}

describe('judgment state budget', () => {
  it('drops a superseded revision and its subject evidence coherently', () => {
    const current = world()
    current.plan = {
      revisions: [
        {
          id: 'revision-old',
          number: 1,
          status: 'superseded',
          digest: 'old',
          createdByDispatchId: 'planner-old',
          createdAtMs: 1,
          approvedAtMs: 2
        },
        {
          id: 'revision-current',
          number: 2,
          status: 'approved',
          digest: 'current',
          createdByDispatchId: null,
          createdAtMs: 3,
          approvedAtMs: 4
        }
      ],
      nodes: [
        {
          revisionId: 'revision-old',
          taskKey: 'old-node',
          deps: [],
          orchestrationTaskId: 'task-old',
          dispatchId: 'dispatch-old',
          state: 'succeeded',
          criteria: [
            {
              id: 'criterion-old',
              ordinal: 0,
              body: 'obsolete '.repeat(500),
              shellCheckable: false,
              checkCommand: null,
              lastCheck: null,
              lastReview: 'pass'
            }
          ]
        }
      ],
      verdicts: [
        {
          dispatchId: 'dispatch-old',
          revisionId: 'revision-old',
          role: 'reviewer',
          verdict: 'approve',
          contentIdentity: 'content-old',
          reportDigest: 'report-old',
          atMs: 5
        }
      ],
      landing: [
        {
          rung: 'files-on-disk',
          revisionId: 'revision-old',
          contentIdentity: 'content-old',
          atMs: 6
        }
      ]
    }
    current.judgmentReports = [
      {
        dispatchId: 'dispatch-old',
        role: 'implementer',
        digest: 'judgment-old',
        payload: { body: 'Old validated report' }
      }
    ]
    const oldAttempt = attempt({
      id: 'attempt-old',
      evidenceKey: 'evidence-old',
      dispatchId: 'dispatch-old',
      revisionId: 'revision-old',
      atMs: 3
    })
    const entries = [oldAttempt, mailboxReport('dispatch-old', 'Old worker report', 4)]
    const full = computeJudgmentIdentity('content-1', current, ledger(entries))
    const bounded = computeJudgmentIdentity('content-1', current, ledger(entries), {
      maxStateBytes: full.serializedBytes - 1
    })
    const state = expanded(bounded)
    const plan = state.objective.plan as ObjectiveWorld['plan']

    expect(bounded.fitsStateBudget).toBe(true)
    expect(plan.revisions.map((revision) => revision.id)).toEqual(['revision-current'])
    expect(plan.nodes).toEqual([])
    expect(plan.verdicts).toEqual([])
    expect(plan.landing).toEqual([])
    expect(state.objective.judgmentReports).toEqual([])
    expect(state.ledger.attempts).toEqual([])
    expect(state.ledger.reports).toEqual([])
    expect(bounded.omittedQuestionSubjectIds).toContain('dispatch-old')
    expect(bounded.truncation?.omitted).toMatchObject({
      revisions: 1,
      nodes: 1,
      verdicts: 1,
      landing: 1,
      judgmentReports: 1,
      attempts: 1,
      reports: 1
    })
  })

  it('prunes completed history by timestamp rather than lexicographic ID', () => {
    const old = attempt({
      id: 'z-old-attempt',
      evidenceKey: 'z-old-evidence',
      dispatchId: 'z-old-dispatch',
      atMs: 10,
      reason: 'old '.repeat(500)
    })
    const recent = attempt({
      id: 'a-new-attempt',
      evidenceKey: 'a-new-evidence',
      dispatchId: 'a-new-dispatch',
      atMs: 20,
      reason: 'new '.repeat(500)
    })
    const full = computeJudgmentIdentity('content-1', world(), ledger([old, recent]))
    const bounded = computeJudgmentIdentity('content-1', world(), ledger([old, recent]), {
      maxStateBytes: full.serializedBytes - 1
    })
    const retained = JSON.stringify(expanded(bounded).ledger.attempts)

    expect(retained).not.toContain('z-old-attempt')
    expect(retained).toContain('a-new-attempt')
    expect(bounded.omittedQuestionSubjectIds).toEqual(['z-old-dispatch'])
  })

  it('ages a completed attempt from its resolution rather than its start', () => {
    const resolvedLate = attempt({
      id: 'started-first',
      evidenceKey: 'started-first',
      dispatchId: 'resolved-late',
      atMs: 1,
      reason: 'late '.repeat(400)
    })
    const completedEarlier = attempt({
      id: 'completed-earlier',
      evidenceKey: 'completed-earlier',
      dispatchId: 'completed-earlier',
      atMs: 50,
      reason: 'earlier '.repeat(400)
    })
    const resolution: WatcherLedger['entries'][number] = {
      eventId: 'late-resolution',
      watcherId,
      atMs: 100,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt-resolved',
      attemptId: 'started-first',
      effect: 'not-landed',
      evidence: {}
    }
    const entries = [resolvedLate, completedEarlier, resolution]
    const full = computeJudgmentIdentity('content-1', world(), ledger(entries))
    const bounded = computeJudgmentIdentity('content-1', world(), ledger(entries), {
      maxStateBytes: full.serializedBytes - 1
    })
    const retained = JSON.stringify(expanded(bounded).ledger.attempts)

    expect(retained).toContain('started-first')
    expect(retained).not.toContain('completed-earlier')
    expect(bounded.omittedQuestionSubjectIds).toEqual(['completed-earlier'])
  })
  it('drops settled unpersisted planner history but pins an older running planner', () => {
    const current = world()
    current.plan.revisions = [
      {
        id: 'revision-current',
        number: 7,
        status: 'approved',
        digest: 'current',
        createdByDispatchId: 'dispatch-current',
        createdAtMs: 70,
        approvedAtMs: 71
      }
    ]
    const planner: WatcherLedger['entries'][number] = {
      eventId: 'planner-old',
      watcherId,
      atMs: 10,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'planner-old',
      fingerprint: 'planner-old',
      action: {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-old',
        evidenceKey: 'planner-old',
        revisionNumber: 3
      },
      state: 'settled',
      dispatchId: 'dispatch-old'
    }
    const ingestion: WatcherLedger['entries'][number] = {
      eventId: 'ingest-old',
      watcherId,
      atMs: 12,
      origin: 'owner',

      class: 'fact',
      kind: 'attempt',
      attemptId: 'ingest-old',
      fingerprint: 'ingest-old',
      action: {
        kind: 'ingest-plan',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-old',
        evidenceKey: 'ingest-old',
        dispatchId: 'dispatch-old',
        revisionNumber: 3
      },
      state: 'settled'
    }
    const pending: WatcherLedger['entries'][number] = {
      ...planner,
      eventId: 'planner-pending',
      attemptId: 'planner-pending',
      fingerprint: 'planner-pending',
      atMs: 20,
      action: { ...planner.action, evidenceKey: 'planner-pending', revisionNumber: 5 },
      state: 'running',
      dispatchId: 'dispatch-pending'
    }
    const entries = [
      planner,
      mailboxReport('dispatch-old', 'obsolete '.repeat(200), 11),
      ingestion,
      pending
    ]
    const full = computeJudgmentIdentity('content-1', current, ledger(entries))
    const bounded = computeJudgmentIdentity('content-1', current, ledger(entries), {
      maxStateBytes: full.serializedBytes - 1
    })
    const retained = JSON.stringify(expanded(bounded).ledger)

    expect(retained).not.toContain('planner-old')
    expect(retained).not.toContain('ingest-old')
    expect(retained).toContain('planner-pending')
    expect(bounded.omittedQuestionSubjectIds).toEqual(['dispatch-old'])
  })
  it('pins an indeterminate worker even when its revision is superseded', () => {
    const current = world()
    current.plan.revisions = [
      {
        id: 'revision-old',
        number: 1,
        status: 'superseded',
        digest: 'old',
        createdByDispatchId: null,
        createdAtMs: 1,
        approvedAtMs: 2
      },
      {
        id: 'revision-current',
        number: 2,
        status: 'approved',
        digest: 'current',
        createdByDispatchId: null,
        createdAtMs: 3,
        approvedAtMs: 4
      }
    ]
    const unresolved = attempt({
      id: 'unresolved',
      evidenceKey: 'unresolved',
      dispatchId: 'unresolved-dispatch',
      revisionId: 'revision-old',
      atMs: 5,
      reason: 'indeterminate '.repeat(300)
    })
    if (unresolved.kind !== 'attempt') {
      throw new Error('attempt fixture is invalid')
    }
    unresolved.effect = 'indeterminate'
    const full = computeJudgmentIdentity('content-1', current, ledger([unresolved]))
    const bounded = computeJudgmentIdentity('content-1', current, ledger([unresolved]), {
      maxStateBytes: full.serializedBytes - 1
    })
    const state = expanded(bounded)
    const plan = state.objective.plan as ObjectiveWorld['plan']

    expect(bounded.fitsStateBudget).toBe(false)
    expect(plan.revisions.map((revision) => revision.id)).toEqual([
      'revision-old',
      'revision-current'
    ])
    expect(JSON.stringify(state.ledger.attempts)).toContain('unresolved')
  })

  it('measures UTF-8 bytes and truncation metadata at the exact boundary', () => {
    const current = world()
    current.contract = { ...current.contract, objectiveText: '現在の目標' }
    const historical = attempt({
      id: 'multibyte-old',
      evidenceKey: 'multibyte-old',
      dispatchId: 'multibyte-dispatch',
      atMs: 1,
      reason: '界'.repeat(1_000)
    })
    const full = computeJudgmentIdentity('content-1', current, ledger([historical]))
    const bounded = computeJudgmentIdentity('content-1', current, ledger([historical]), {
      maxStateBytes: full.serializedBytes - 1
    })
    const exact = computeJudgmentIdentity('content-1', current, ledger([historical]), {
      maxStateBytes: bounded.serializedBytes
    })
    const short = computeJudgmentIdentity('content-1', current, ledger([historical]), {
      maxStateBytes: bounded.serializedBytes - 1
    })

    expect(bounded.serializedBytes).toBe(Buffer.byteLength(bounded.serializedState, 'utf8'))
    expect(bounded.serializedBytes).toBeGreaterThan(bounded.serializedState.length)
    expect(bounded.truncation?.omitted.attempts).toBe(1)
    expect(exact.fitsStateBudget).toBe(true)
    expect(exact.stateIdentity).toBe(bounded.stateIdentity)
    expect(short.fitsStateBudget).toBe(false)
  })

  it('preserves running and open evidence and never slices a mandatory initial seed', () => {
    const current = world()
    current.plan.revisions = [
      {
        id: 'revision-current',
        number: 1,
        status: 'approved',
        digest: 'current',
        createdByDispatchId: null,
        createdAtMs: 1,
        approvedAtMs: 2
      }
    ]
    const historical = attempt({
      id: 'historical',
      evidenceKey: 'historical',
      dispatchId: 'historical-dispatch',
      atMs: 1,
      reason: 'old '.repeat(500)
    })
    const running = attempt({
      id: 'running',
      evidenceKey: 'running',
      dispatchId: 'running-dispatch',
      revisionId: 'revision-current',
      state: 'running',
      atMs: 2
    })
    const escalation: EvidenceEntry = {
      eventId: 'active-escalation',
      watcherId,
      atMs: 3,
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'orchestration-mailbox',
      payload: {
        type: 'escalation',
        body: 'Current blocker',
        payload: { dispatchId: 'running-dispatch' }
      }
    }
    const entries = [historical, running, escalation]
    const full = computeJudgmentIdentity('content-1', current, ledger(entries))
    const bounded = computeJudgmentIdentity('content-1', current, ledger(entries), {
      maxStateBytes: full.serializedBytes - 1
    })

    expect(bounded.fitsStateBudget).toBe(true)
    const boundedState = expanded(bounded)
    expect(JSON.stringify(boundedState.ledger.attempts)).not.toContain('historical')
    expect(JSON.stringify(boundedState.ledger.attempts)).toContain('running')
    expect(boundedState.ledger.latestEscalation).toMatchObject({ body: 'Current blocker' })

    const initial = world()
    initial.contract = { ...initial.contract, existingPlan: '界'.repeat(1_000) }
    const initialFull = computeJudgmentIdentity('content-1', initial, ledger([]))
    const unavailable = computeJudgmentIdentity('content-1', initial, ledger([]), {
      maxStateBytes: initialFull.serializedBytes - 1
    })
    expect(unavailable.fitsStateBudget).toBe(false)
    expect(unavailable.truncation).toBeNull()
    expect(expanded(unavailable).objective.contract.existingPlan).toBe(
      initial.contract.existingPlan
    )
  })
})
