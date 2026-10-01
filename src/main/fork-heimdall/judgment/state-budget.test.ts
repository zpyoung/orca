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
import { projectBoundedJudgmentState } from './state-budget'

function projectedPlan(state: JudgmentState): ObjectiveWorld['plan'] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: judgment state preserves the objective plan object shape, whose projection is intentionally typed as unknown.
  return state.objective.plan as ObjectiveWorld['plan']
}

const watcherId = 'budget-watcher'

function world(): ObjectiveWorld {
  return buildWorld({ withCapabilities: true })
}

function planRevision(
  id: string,
  number: number,
  status: 'draft' | 'rejected',
  createdAtMs: number,
  createdByDispatchId: string | null = null
): ObjectiveWorld['plan']['revisions'][number] {
  return { id, number, status, digest: id, createdByDispatchId, createdAtMs, approvedAtMs: null }
}

function worldWithDraftCriterion(input: {
  body: string
  checkCommand: string
  lastCheck?: ObjectiveWorld['plan']['nodes'][number]['criteria'][number]['lastCheck']
  rejectedHistory?: boolean
}): ObjectiveWorld {
  const current = world()
  const hasRejectedHistory = input.rejectedHistory ?? false
  current.plan.revisions = [
    ...(hasRejectedHistory ? [planRevision('revision-rejected', 1, 'rejected', 1)] : []),
    planRevision('revision-draft', hasRejectedHistory ? 2 : 1, 'draft', hasRejectedHistory ? 20 : 1)
  ]
  const draftNode: ObjectiveWorld['plan']['nodes'][number] = {
    revisionId: 'revision-draft',
    taskKey: 'draft-task',
    deps: [],
    orchestrationTaskId: 'task-draft',
    dispatchId: 'dispatch-draft',
    state: 'pending',
    criteria: [
      {
        id: 'criterion-live',
        ordinal: 0,
        body: input.body,
        shellCheckable: true,
        checkCommand: input.checkCommand,
        lastCheck: input.lastCheck ?? null,
        lastReview: input.lastCheck ? 'pass' : null
      }
    ]
  }
  const rejectedNode: ObjectiveWorld['plan']['nodes'][number] = {
    revisionId: 'revision-rejected',
    taskKey: 'rejected-task',
    deps: [],
    orchestrationTaskId: 'task-rejected',
    dispatchId: 'dispatch-rejected',
    state: 'failed',
    criteria: [
      {
        id: 'criterion-rejected',
        ordinal: 0,
        body: 'old '.repeat(2_000),
        shellCheckable: false,
        checkCommand: null,
        lastCheck: null,
        lastReview: null
      }
    ]
  }
  current.plan.nodes = [...(hasRejectedHistory ? [rejectedNode] : []), draftNode]
  return current
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: objective.plan is typed unknown on the wire state by design; this narrows it back to the known ObjectiveWorld shape the fixture produced.
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: objective.plan is typed unknown on the wire state by design; this narrows it back to the known ObjectiveWorld shape the fixture produced.
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
    const unavailable = projectBoundedJudgmentState('content-1', initial, ledger([]), {
      maxStateBytes: initialFull.serializedBytes - 1
    })
    const unavailableState = expandJudgmentState<JudgmentState>(unavailable.state)
    expect(unavailable.fitsStateBudget).toBe(false)
    expect(unavailable.truncation).toBeNull()
    expect(unavailableState.objective.contract.existingPlan).toBe(initial.contract.existingPlan)
  })

  it('drops a rejected revision, its padded node, and its planner, ingest, and review attempts', () => {
    const current = world()
    current.plan.revisions = [
      planRevision('revision-rejected', 1, 'rejected', 1, 'planner-rejected'),
      planRevision('revision-draft', 2, 'draft', 20)
    ]
    current.plan.nodes = [
      {
        revisionId: 'revision-rejected',
        taskKey: 'rejected-node',
        deps: [],
        orchestrationTaskId: 'task-rejected',
        dispatchId: 'node-rejected',
        state: 'failed',
        criteria: [
          {
            id: 'criterion-rejected',
            ordinal: 0,
            body: 'obsolete criterion '.repeat(300),
            shellCheckable: false,
            checkCommand: null,
            lastCheck: null,
            lastReview: null
          }
        ]
      }
    ]
    const planner: WatcherLedger['entries'][number] = {
      eventId: 'event-planner-rejected',
      watcherId,
      atMs: 2,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-planner-rejected',
      fingerprint: 'fingerprint-planner-rejected',
      action: {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'planner-rejected',
        revisionNumber: 1,
        reason: 'initial'
      },
      state: 'settled',
      effect: 'landed',
      dispatchId: 'planner-rejected'
    }
    const ingestion: WatcherLedger['entries'][number] = {
      eventId: 'event-ingest-rejected',
      watcherId,
      atMs: 3,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-ingest-rejected',
      fingerprint: 'fingerprint-ingest-rejected',
      action: {
        kind: 'ingest-plan',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'ingest-rejected',
        recovery: 'replay-safe',
        dispatchId: 'planner-rejected',
        revisionNumber: 1,
        reportPath: 'reports/rejected-plan.json'
      },
      state: 'settled',
      effect: 'landed',
      dispatchId: 'planner-rejected'
    }
    const review: WatcherLedger['entries'][number] = {
      eventId: 'event-review-rejected',
      watcherId,
      atMs: 4,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-review-rejected',
      fingerprint: 'fingerprint-review-rejected',
      action: {
        kind: 'dispatch-reviewer',
        capability: 'review',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'review-rejected',
        revisionId: 'revision-rejected'
      },
      state: 'settled',
      effect: 'landed',
      dispatchId: 'review-rejected'
    }
    const entries = [planner, ingestion, review]
    const full = computeJudgmentIdentity('content-1', current, ledger(entries))
    const bounded = computeJudgmentIdentity('content-1', current, ledger(entries), {
      maxStateBytes: full.serializedBytes - 1
    })
    const state = expanded(bounded)
    const plan = projectedPlan(state)

    expect(bounded.fitsStateBudget).toBe(true)
    expect(plan.revisions.map((revision) => revision.id)).toEqual(['revision-draft'])
    expect(plan.nodes).toEqual([])
    expect(state.ledger.attempts).toEqual([])
    expect(bounded.truncation?.omitted).toMatchObject({
      revisions: 1,
      nodes: 1,
      attempts: 3
    })
  })

  it('keeps a rejected revision pinned by an unresolved attempt', () => {
    const current = world()
    current.plan.revisions = [planRevision('revision-rejected', 1, 'rejected', 1)]
    const unresolved = attempt({
      id: 'unresolved-rejected',
      evidenceKey: 'unresolved-rejected',
      dispatchId: 'rejected-dispatch',
      revisionId: 'revision-rejected',
      state: 'running',
      atMs: 2
    })
    const full = computeJudgmentIdentity('content-1', current, ledger([unresolved]))
    const bounded = computeJudgmentIdentity('content-1', current, ledger([unresolved]), {
      maxStateBytes: full.serializedBytes - 1
    })
    const state = expanded(bounded)
    const plan = projectedPlan(state)

    expect(bounded.fitsStateBudget).toBe(false)
    expect(bounded.truncation).toBeNull()
    expect(plan.revisions.map((revision) => revision.id)).toEqual(['revision-rejected'])
    expect(state.ledger.attempts).toMatchObject([{ attemptId: 'unresolved-rejected' }])
  })

  it('keeps a rejected revision pinned by an unresolved plan-review dispatch', () => {
    const current = world()
    current.plan.revisions = [planRevision('revision-rejected', 1, 'rejected', 1)]
    current.plan.planReviews = [
      {
        id: 'review-rejected',
        targetKind: 'revision',
        targetId: 'revision-rejected',
        round: 1,
        dispatchId: 'plan-review',
        verdict: 'revise',
        reportDigest: 'report-rejected',
        createdAtMs: 2
      }
    ]
    // no revisionId on the action, so only the plan review's dispatch ties it to the revision
    const unresolved = attempt({
      id: 'unresolved-plan-review',
      evidenceKey: 'unresolved-plan-review',
      dispatchId: 'plan-review',
      state: 'running',
      atMs: 3
    })
    const full = computeJudgmentIdentity('content-1', current, ledger([unresolved]))
    const bounded = computeJudgmentIdentity('content-1', current, ledger([unresolved]), {
      maxStateBytes: full.serializedBytes - 1
    })
    const plan = projectedPlan(expanded(bounded))

    expect(plan.revisions.map((revision) => revision.id)).toEqual(['revision-rejected'])
    expect(plan.planReviews?.map((review) => review.id)).toEqual(['review-rejected'])
  })

  it('keeps a rejected revision pinned by an active escalation', () => {
    const current = world()
    current.plan.revisions = [
      planRevision('revision-rejected', 1, 'rejected', 1, 'rejected-dispatch')
    ]
    const escalation: EvidenceEntry = {
      eventId: 'active-rejected-escalation',
      watcherId,
      atMs: 2,
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: 'orchestration-mailbox',
      payload: {
        type: 'escalation',
        body: 'Review remains unresolved',
        payload: { dispatchId: 'rejected-dispatch' }
      }
    }
    const full = computeJudgmentIdentity('content-1', current, ledger([escalation]))
    const bounded = computeJudgmentIdentity('content-1', current, ledger([escalation]), {
      maxStateBytes: full.serializedBytes - 1
    })
    const state = expanded(bounded)
    const plan = projectedPlan(state)

    expect(bounded.fitsStateBudget).toBe(false)
    expect(bounded.truncation).toBeNull()
    expect(plan.revisions.map((revision) => revision.id)).toEqual(['revision-rejected'])
    expect(state.ledger.latestEscalation).toMatchObject({
      body: 'Review remains unresolved'
    })
  })

  it('omits an existing plan seed when only a draft revision exists', () => {
    const current = world()
    current.contract.existingPlan = 'existing plan seed '.repeat(300)
    current.plan.revisions = [planRevision('revision-draft', 1, 'draft', 1)]
    const full = computeJudgmentIdentity('content-1', current, ledger([]))
    const bounded = computeJudgmentIdentity('content-1', current, ledger([]), {
      maxStateBytes: full.serializedBytes - 1
    })
    const state = expanded(bounded)
    const plan = projectedPlan(state)

    expect(bounded.fitsStateBudget).toBe(true)
    expect(state.objective.contract.existingPlan).toBeUndefined()
    expect(plan.revisions.map((revision) => revision.id)).toEqual(['revision-draft'])
    expect(bounded.truncation?.omitted).toMatchObject({ existingPlan: 1, revisions: 0 })
  })

  it('drops rejected revision patches and reviews while retaining gate attempts and omission counts', () => {
    const current = world()
    current.plan.revisions = [
      planRevision('revision-rejected', 1, 'rejected', 1),
      planRevision('revision-draft', 2, 'draft', 20)
    ]
    const rejectedPatch: NonNullable<ObjectiveWorld['plan']['patches']>[number] = {
      id: 'patch-rejected',
      revisionId: 'revision-rejected',
      createdByDispatchId: 'repair-rejected',
      repairOrdinal: 1,
      digest: 'rejected-patch',
      status: 'rejected',
      rejection: 'The repair was rejected',
      touchedTaskKeys: ['old-task'],
      createdAtMs: 2,
      resolvedAtMs: 3
    }
    const draftPatch: NonNullable<ObjectiveWorld['plan']['patches']>[number] = {
      id: 'patch-draft',
      revisionId: 'revision-draft',
      createdByDispatchId: 'repair-draft',
      repairOrdinal: 1,
      digest: 'draft-patch',
      status: 'pending',
      rejection: null,
      touchedTaskKeys: ['current-task'],
      createdAtMs: 21,
      resolvedAtMs: null
    }
    const rejectedRevisionReview: NonNullable<ObjectiveWorld['plan']['planReviews']>[number] = {
      id: 'review-rejected-revision',
      targetKind: 'revision',
      targetId: 'revision-rejected',
      round: 1,
      dispatchId: 'review-rejected-revision',
      verdict: 'revise',
      reportDigest: 'report-rejected-revision',
      createdAtMs: 4
    }
    const rejectedPatchReview: NonNullable<ObjectiveWorld['plan']['planReviews']>[number] = {
      id: 'review-rejected-patch',
      targetKind: 'patch',
      targetId: 'patch-rejected',
      round: 1,
      dispatchId: 'review-rejected-patch',
      verdict: 'revise',
      reportDigest: 'report-rejected-patch',
      createdAtMs: 5
    }
    const draftRevisionReview: NonNullable<ObjectiveWorld['plan']['planReviews']>[number] = {
      id: 'review-draft-revision',
      targetKind: 'revision',
      targetId: 'revision-draft',
      round: 1,
      dispatchId: 'review-draft-revision',
      verdict: 'approve',
      reportDigest: 'report-draft-revision',
      createdAtMs: 22
    }
    const draftPatchReview: NonNullable<ObjectiveWorld['plan']['planReviews']>[number] = {
      id: 'review-draft-patch',
      targetKind: 'patch',
      targetId: 'patch-draft',
      round: 1,
      dispatchId: 'review-draft-patch',
      verdict: 'escalate',
      reportDigest: 'report-draft-patch',
      createdAtMs: 23
    }
    const gateAttempts = [
      {
        gateName: 'unit',
        contentIdentity: 'content-1',
        executionHostId: 'host-1',
        command: 'pnpm test',
        exitCode: 0,
        timedOut: false,
        stdoutTail: 'passed',
        stderrTail: null,
        startedAtMs: 6,
        completedAtMs: 7
      },
      {
        gateName: 'typecheck',
        contentIdentity: 'content-2',
        executionHostId: 'host-2',
        command: 'pnpm typecheck',
        exitCode: 1,
        timedOut: false,
        stdoutTail: null,
        stderrTail: 'failed',
        startedAtMs: 24,
        completedAtMs: 25
      }
    ]
    current.plan.patches = [rejectedPatch, draftPatch]
    current.plan.planReviews = [
      rejectedRevisionReview,
      rejectedPatchReview,
      draftRevisionReview,
      draftPatchReview
    ]
    current.plan.gateAttempts = gateAttempts

    const full = computeJudgmentIdentity('content-1', current, ledger([]))
    const bounded = computeJudgmentIdentity('content-1', current, ledger([]), {
      maxStateBytes: full.serializedBytes - 1
    })
    const plan = projectedPlan(expanded(bounded))

    expect(bounded.fitsStateBudget).toBe(true)
    expect(plan.patches?.map(({ id, revisionId }) => ({ id, revisionId }))).toEqual([
      { id: 'patch-draft', revisionId: 'revision-draft' }
    ])
    expect(plan.planReviews?.map(({ id, targetId }) => ({ id, targetId }))).toEqual([
      { id: 'review-draft-revision', targetId: 'revision-draft' },
      { id: 'review-draft-patch', targetId: 'patch-draft' }
    ])
    expect(
      plan.gateAttempts?.map(
        ({
          gateName,
          contentIdentity,
          executionHostId,
          command,
          exitCode,
          timedOut,
          stdoutTail,
          stderrTail
        }) => ({
          gateName,
          contentIdentity,
          executionHostId,
          command,
          exitCode,
          timedOut,
          stdoutTail,
          stderrTail
        })
      )
    ).toEqual([
      {
        gateName: 'unit',
        contentIdentity: 'content-1',
        executionHostId: 'host-1',
        command: 'pnpm test',
        exitCode: 0,
        timedOut: false,
        stdoutTail: 'passed',
        stderrTail: null
      },
      {
        gateName: 'typecheck',
        contentIdentity: 'content-2',
        executionHostId: 'host-2',
        command: 'pnpm typecheck',
        exitCode: 1,
        timedOut: false,
        stdoutTail: null,
        stderrTail: 'failed'
      }
    ])
    expect(bounded.truncation?.omitted).toMatchObject({
      patches: 1,
      planReviews: 2,
      clippedCriterionStrings: 0,
      criterionCodeUnitCap: 0
    })
  })

  it('omits an existing plan before a newer rejected revision', () => {
    const current = world()
    current.contract.existingPlan = 'seed '.repeat(300)
    current.plan.revisions = [planRevision('revision-rejected', 1, 'rejected', 100)]
    const full = computeJudgmentIdentity('content-1', current, ledger([]))
    const bounded = computeJudgmentIdentity('content-1', current, ledger([]), {
      maxStateBytes: full.serializedBytes - 1
    })
    const plan = projectedPlan(expanded(bounded))

    expect(bounded.fitsStateBudget).toBe(true)
    expect(expanded(bounded).objective.contract.existingPlan).toBeUndefined()
    expect(plan.revisions.map((revision) => revision.id)).toEqual(['revision-rejected'])
    expect(bounded.truncation?.omitted).toMatchObject({
      existingPlan: 1,
      revisions: 0
    })
  })

  it('clips only retained draft criterion strings after omission is insufficient', () => {
    const body = 'b'.repeat(8_192)
    const checkCommand = 'c'.repeat(8_192)
    const lastCheck = {
      contentIdentity: 'content-1',
      exitCode: 0,
      timedOut: false,
      atMs: 2
    }
    const current = worldWithDraftCriterion({ body, checkCommand, lastCheck })
    const bounded = computeJudgmentIdentity('content-1', current, ledger([]), {
      maxStateBytes: 4_096
    })
    const plan = projectedPlan(expanded(bounded))
    const retainedCriterion = plan.nodes[0]?.criteria[0]
    const criterionCap = bounded.truncation?.omitted.criterionCodeUnitCap ?? 0

    expect(bounded.fitsStateBudget).toBe(true)
    expect(bounded.truncation?.version).toBe(2)
    expect(bounded.truncation?.omitted.clippedCriterionStrings).toBe(2)
    expect(criterionCap).toBeGreaterThanOrEqual(256)
    expect(criterionCap).toBeLessThan(8_192)
    expect(bounded.truncationNotice).toContain(
      `clipped 2 criterion string(s) to ${criterionCap} code units`
    )
    expect(retainedCriterion).toMatchObject({
      id: 'criterion-live',
      body: `${body.slice(0, criterionCap)}…`,
      checkCommand: `${checkCommand.slice(0, criterionCap)}…`,
      lastCheck: { contentIdentity: 'content-1', exitCode: 0, timedOut: false }
    })
    expect(retainedCriterion?.body).toHaveLength(criterionCap + 1)
    expect(retainedCriterion?.checkCommand).toHaveLength(criterionCap + 1)
  })

  it('does not clip a live draft when omitting a rejected revision makes the state fit', () => {
    const body = 'draft body '.repeat(700)
    const checkCommand = 'pnpm check '.repeat(700)
    const current = worldWithDraftCriterion({ body, checkCommand, rejectedHistory: true })
    const full = computeJudgmentIdentity('content-1', current, ledger([]))
    const bounded = computeJudgmentIdentity('content-1', current, ledger([]), {
      maxStateBytes: full.serializedBytes - 1
    })
    const plan = projectedPlan(expanded(bounded))
    const retainedCriterion = plan.nodes[0]?.criteria[0]

    expect(bounded.fitsStateBudget).toBe(true)
    expect(plan.revisions.map((revision) => revision.id)).toEqual(['revision-draft'])
    expect(plan.nodes.map((node) => node.revisionId)).toEqual(['revision-draft'])
    expect(retainedCriterion?.body).toBe(body)
    expect(retainedCriterion?.checkCommand).toBe(checkCommand)
    expect(bounded.truncation?.omitted.clippedCriterionStrings).toBe(0)
    expect(bounded.truncation?.omitted.criterionCodeUnitCap).toBe(0)
  })

  it('keeps the 256-code-unit clipping floor even when the mandatory state still overflows', () => {
    const body = 'b'.repeat(8_192)
    const checkCommand = 'c'.repeat(8_192)
    const lastCheck = {
      contentIdentity: 'content-1',
      exitCode: 0,
      timedOut: false,
      atMs: 2
    }
    const current = worldWithDraftCriterion({ body, checkCommand, lastCheck })
    const bounded = computeJudgmentIdentity('content-1', current, ledger([]), {
      maxStateBytes: 256
    })
    const plan = projectedPlan(expanded(bounded))
    const retainedCriterion = plan.nodes[0]?.criteria[0]

    expect(bounded.fitsStateBudget).toBe(false)
    expect(bounded.truncation?.omitted.clippedCriterionStrings).toBe(2)
    expect(bounded.truncation?.omitted.criterionCodeUnitCap).toBe(256)
    expect(retainedCriterion).toMatchObject({
      id: 'criterion-live',
      body: `${body.slice(0, 256)}…`,
      checkCommand: `${checkCommand.slice(0, 256)}…`,
      lastCheck: { contentIdentity: 'content-1', exitCode: 0, timedOut: false }
    })
    expect(retainedCriterion?.body).toHaveLength(257)
    expect(retainedCriterion?.checkCommand).toHaveLength(257)
  })

  it('never splits a surrogate pair at the clipping cap', () => {
    // 255 ASCII units put the emoji's high surrogate exactly at code unit 256
    const body = `${'b'.repeat(255)}${'😀'.repeat(4_000)}`
    const current = worldWithDraftCriterion({ body, checkCommand: 'c'.repeat(8_192) })
    const bounded = computeJudgmentIdentity('content-1', current, ledger([]), {
      maxStateBytes: 256
    })
    const retainedBody = projectedPlan(expanded(bounded)).nodes[0]?.criteria[0]?.body

    expect(retainedBody).toBe(`${'b'.repeat(255)}…`)
  })
})
