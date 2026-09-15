import { describe, expect, it } from 'vitest'
import type {
  AttemptEntry,
  EvidenceEntry,
  LedgerEntry,
  WatcherLedger
} from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import { decideObjective } from './decision'
import type { ObjectiveAction } from './objective-actions'
import type {
  ObjectiveNodeProjection,
  ObjectiveProjection,
  ObjectiveRevisionProjection,
  ObjectiveWorld
} from './detail-types'

const CONTRACT: ObjectiveWorld['contract'] = {
  objectiveText: 'Implement the objective',
  tier: 'standard',
  landingBar: 'files-on-disk',
  maxConcurrency: 1,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

function revision(
  overrides: Partial<ObjectiveRevisionProjection> = {}
): ObjectiveRevisionProjection {
  return {
    id: 'revision-1',
    number: 1,
    status: 'approved',
    digest: 'plan-digest',
    createdByDispatchId: 'planner-dispatch',
    createdAtMs: 10,
    approvedAtMs: 20,
    ...overrides
  }
}

function node(
  taskKey: string,
  overrides: Partial<ObjectiveNodeProjection> = {}
): ObjectiveNodeProjection {
  return {
    revisionId: 'revision-1',
    taskKey,
    deps: [],
    orchestrationTaskId: null,
    dispatchId: null,
    state: 'pending',
    criteria: [],
    ...overrides
  }
}

function projection(overrides: Partial<ObjectiveProjection> = {}): ObjectiveProjection {
  return {
    revisions: [revision()],
    nodes: [node('core')],
    verdicts: [],
    landing: [],
    ...overrides
  }
}

function snapshot(
  plan: ObjectiveProjection,
  overrides: Partial<ObjectiveWorld> = {},
  contentIdentity = 'content-current'
): Snapshot<ObjectiveWorld> {
  return {
    freshness: 'live',
    contentIdentity,
    observedAtMs: 100,
    world: {
      contract: CONTRACT,
      workspaceKind: 'git',
      plan,
      reports: [],
      budget: { wallClockActiveMs: 60_000, turns: 20 },
      ...overrides
    }
  }
}

function attempt(
  action: ObjectiveAction,
  options: {
    state?: AttemptEntry['state']
    effect?: AttemptEntry['effect']
    dispatchId?: string
    atMs?: number
  } = {}
): AttemptEntry {
  const dispatchAction = action.kind.startsWith('dispatch-')
  return {
    kind: 'attempt',
    eventId: `event-${options.dispatchId ?? action.evidenceKey}`,
    watcherId: 'watcher-1',
    atMs: options.atMs ?? 30,
    origin: 'owner',
    class: 'fact',
    attemptId: `attempt-${options.dispatchId ?? action.evidenceKey}`,
    fingerprint: `fingerprint-${options.dispatchId ?? action.evidenceKey}`,
    action,
    state: options.state ?? 'running',
    ...(options.effect === undefined ? {} : { effect: options.effect }),
    ...(dispatchAction
      ? {
          dispatch: {
            spec: 'role prompt',
            taskKey: action.kind === 'dispatch-node' ? action.taskKey : action.kind,
            dispatchKind: 'child' as const
          }
        }
      : {}),
    ...(options.dispatchId === undefined ? {} : { dispatchId: options.dispatchId })
  }
}

function workerDone(dispatchId: string, reportPath = '/outside/report.json'): EvidenceEntry {
  return {
    kind: 'evidence',
    eventId: `evidence-${dispatchId}`,
    watcherId: 'watcher-1',
    atMs: 40,
    origin: 'owner',
    class: 'fact',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      payload: {
        dispatchId,
        taskId: `task-${dispatchId}`,
        outcome: 'succeeded',
        reportPath,
        filesModified: ['src/core.ts']
      }
    }
  }
}

function workerHeartbeat(dispatchId: string): EvidenceEntry {
  return {
    kind: 'evidence',
    eventId: `heartbeat-${dispatchId}`,
    watcherId: 'watcher-1',
    atMs: 35,
    origin: 'owner',
    class: 'fact',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'heartbeat',
      payload: { dispatchId, taskId: `first-task-${dispatchId}` }
    }
  }
}

function ledger(entries: LedgerEntry[] = []): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

describe('objective deterministic phase flow', () => {
  it('dispatches the initial planner with a stable revision evidence key', () => {
    const decision = decideObjective(snapshot(projection({ revisions: [], nodes: [] })), ledger())
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:1',
      revisionNumber: 1,
      reason: 'initial',
      contentIdentity: 'content-current'
    })
  })

  it('activates a draft before dispatching implementation', () => {
    const draft = revision({ status: 'draft', approvedAtMs: null })
    expect(
      decideObjective(snapshot(projection({ revisions: [draft], nodes: [] })), ledger()).action
    ).toMatchObject({
      kind: 'activate-plan',
      evidenceKey: 'revision-1',
      recovery: 'replay-safe'
    })
  })

  it('activates a newer replan draft even while the prior revision remains approved', () => {
    const replanDraft = revision({
      id: 'revision-2',
      number: 2,
      status: 'draft',
      digest: 'replan-digest',
      createdByDispatchId: 'planner-dispatch-2',
      approvedAtMs: null
    })
    const plan = projection({
      revisions: [revision(), replanDraft],
      nodes: [node('core', { state: 'failed' })]
    })
    expect(decideObjective(snapshot(plan), ledger()).action).toMatchObject({
      kind: 'activate-plan',
      revisionId: 'revision-2',
      digest: 'replan-digest'
    })
  })

  it('dispatches the first ready node with completed dependency orchestration ids', () => {
    const plan = projection({
      nodes: [
        node('base', {
          state: 'succeeded',
          orchestrationTaskId: 'orchestration-base',
          dispatchId: 'dispatch-base'
        }),
        node('dependent', { deps: ['base'] })
      ]
    })
    expect(decideObjective(snapshot(plan), ledger()).action).toMatchObject({
      kind: 'dispatch-node',
      taskKey: 'dependent',
      evidenceKey: 'revision-1:dependent',
      depsOrchestrationIds: ['orchestration-base']
    })
  })

  it('replans with new evidence after a failed node instead of retrying it', () => {
    const plan = projection({ nodes: [node('core', { state: 'failed', dispatchId: 'failed' })] })
    expect(decideObjective(snapshot(plan), ledger()).action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:2',
      revisionNumber: 2,
      reason: 'replan-after-failure'
    })
  })

  it('does not duplicate a node dispatch when workspace content moves', () => {
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-before-worker',
      evidenceKey: 'revision-1:core',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const decision = decideObjective(
      snapshot(projection(), {}, 'content-after-worker-edit'),
      ledger([attempt(dispatch, { dispatchId: 'dispatch-core' })])
    )
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({ reason: 'node-in-flight' })
  })

  it('honors a resolution fact over a stale running attempt revision', () => {
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:core',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const decision = decideObjective(
      snapshot(projection()),
      ledger([
        attempt(dispatch, { dispatchId: 'dispatch-core' }),
        {
          kind: 'attempt-resolved',
          eventId: 'event-resolution',
          watcherId: 'watcher-1',
          atMs: 40,
          origin: 'owner',
          class: 'fact',
          attemptId: 'attempt-dispatch-core',
          effect: 'not-landed',
          evidence: { reason: 'worker failed' }
        }
      ])
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:2',
      reason: 'replan-after-failure'
    })
  })

  it('replans after a settled worker omits its required report', () => {
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:core',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const decision = decideObjective(
      snapshot(projection()),
      ledger([
        attempt(dispatch, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-core' })
      ])
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:2',
      reason: 'replan-after-failure'
    })
  })

  it('ingests a completed report at current content while retaining dispatch identity', () => {
    const dispatch: ObjectiveAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-before-worker',
      evidenceKey: 'revision-1:core',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: []
    }
    const plan = projection({
      nodes: [node('core', { state: 'dispatched', dispatchId: 'dispatch-core' })]
    })
    const decision = decideObjective(
      snapshot(plan, {}, 'content-after-worker-edit'),
      ledger([
        attempt(dispatch, { state: 'settled', effect: 'landed', dispatchId: 'dispatch-core' }),
        workerHeartbeat('dispatch-core'),
        workerDone('dispatch-core')
      ])
    )
    expect(decision.action).toMatchObject({
      kind: 'ingest-report',
      dispatchId: 'dispatch-core',
      orchestrationTaskId: 'first-task-dispatch-core',
      contentIdentity: 'content-after-worker-edit',
      dispatchedContentIdentity: 'content-before-worker',
      recovery: 'replay-safe'
    })
  })

  it('treats a check failure at current identity as a replan boundary', () => {
    const checked = node('core', {
      state: 'succeeded',
      criteria: [
        {
          id: 'criterion-1',
          ordinal: 0,
          shellCheckable: true,
          checkCommand: 'pnpm check',
          lastCheck: { contentIdentity: 'content-current', exitCode: 1, timedOut: false, atMs: 50 },
          lastReview: null
        }
      ]
    })
    expect(
      decideObjective(snapshot(projection({ nodes: [checked] })), ledger()).action
    ).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:2',
      reason: 'replan-after-failure'
    })
  })
})

describe('objective tier review policy', () => {
  const implemented = projection({ nodes: [node('core', { state: 'succeeded' })] })

  it('express skips review and records files on disk', () => {
    const decision = decideObjective(
      snapshot(implemented, { contract: { ...CONTRACT, tier: 'express' } }),
      ledger()
    )
    expect(decision.action).toMatchObject({
      kind: 'record-landing',
      evidenceKey: 'files-on-disk:content-current',
      recovery: 'replay-safe'
    })
  })

  it('standard dispatches the reviewer before landing', () => {
    expect(decideObjective(snapshot(implemented), ledger()).action).toMatchObject({
      kind: 'dispatch-reviewer',
      evidenceKey: 'revision-1:review:content-current'
    })
  })

  it('does not duplicate an in-flight reviewer when content moves', () => {
    const reviewDispatch: ObjectiveAction = {
      kind: 'dispatch-reviewer',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-before-review',
      evidenceKey: 'revision-1:review:content-before-review',
      revisionId: 'revision-1'
    }
    const decision = decideObjective(
      snapshot(implemented, {}, 'content-after-human-edit'),
      ledger([attempt(reviewDispatch, { dispatchId: 'review-dispatch' })])
    )
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({ reason: 'review-in-flight' })
  })

  it('full dispatches the integrator only after a current reviewer approval', () => {
    const reviewed = projection({
      nodes: [node('core', { state: 'succeeded' })],
      verdicts: [
        {
          dispatchId: 'review-dispatch',
          revisionId: 'revision-1',
          role: 'reviewer',
          verdict: 'approve',
          contentIdentity: 'content-current',
          reportDigest: 'review-digest',
          atMs: 50
        }
      ]
    })
    const decision = decideObjective(
      snapshot(reviewed, { contract: { ...CONTRACT, tier: 'full' } }),
      ledger()
    )
    expect(decision.action).toMatchObject({
      kind: 'dispatch-integrator',
      evidenceKey: 'revision-1:review:content-current'
    })
  })

  it('full lands only after both reviewer and integrator approve current content', () => {
    const fullyReviewed = projection({
      nodes: [node('core', { state: 'succeeded' })],
      verdicts: [
        {
          dispatchId: 'review-dispatch',
          revisionId: 'revision-1',
          role: 'reviewer',
          verdict: 'approve',
          contentIdentity: 'content-current',
          reportDigest: 'review-digest',
          atMs: 50
        },
        {
          dispatchId: 'integrator-dispatch',
          revisionId: 'revision-1',
          role: 'integrator',
          verdict: 'approve',
          contentIdentity: 'content-current',
          reportDigest: 'integrator-digest',
          atMs: 60
        }
      ]
    })
    expect(
      decideObjective(
        snapshot(fullyReviewed, { contract: { ...CONTRACT, tier: 'full' } }),
        ledger()
      ).action
    ).toMatchObject({ kind: 'record-landing', revisionId: 'revision-1' })
  })

  it('replans after a current blocking review', () => {
    const blocked = projection({
      nodes: [node('core', { state: 'succeeded' })],
      verdicts: [
        {
          dispatchId: 'review-dispatch',
          revisionId: 'revision-1',
          role: 'reviewer',
          verdict: 'block',
          contentIdentity: 'content-current',
          reportDigest: 'review-digest',
          atMs: 50
        }
      ]
    })
    expect(decideObjective(snapshot(blocked), ledger()).action).toMatchObject({
      kind: 'dispatch-planner',
      evidenceKey: 'plan:2',
      reason: 'replan-after-block'
    })
  })
})
