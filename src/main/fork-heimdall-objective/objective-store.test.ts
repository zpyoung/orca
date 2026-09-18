import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ObjectiveEnrollmentPayload,
  ObjectiveLandingBar
} from '../../shared/fork-heimdall-objective/contract-types'
import { ObjectiveDetailSchema } from '../../shared/fork-heimdall-objective/detail-types'
import type {
  PlannerReport,
  ReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import type {
  AttemptEntry,
  KernelAction,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import Database from '../sqlite/sync-database'
import { OBJECTIVE_DATABASE_SCHEMA_VERSION, ObjectiveDatabase } from './objective-database'
import type { ObjectiveLandingPayload } from './objective-store-data'
import { ObjectiveStore } from './objective-store'

const WATCHER_ID = 'watcher-objective-1'
const CONTENT_IDENTITY = 'content-identity-1'
const REPORT: PlannerReport = {
  plan: [
    {
      taskKey: 'task-a',
      title: 'Secret node title A',
      spec: 'Secret implementer specification A',
      deps: [],
      criteria: [
        { body: 'Secret acceptance body A', shellCheckable: true, checkCommand: 'pnpm check:a' }
      ],
      declaresDependencyChange: false
    },
    {
      taskKey: 'task-b',
      title: 'Secret node title B',
      spec: 'Secret implementer specification B',
      deps: ['task-a'],
      criteria: [{ body: 'Secret acceptance body B', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
  ]
}
const REVIEW: ReviewerReport = {
  verdict: 'approve',
  criteriaResults: [
    { taskKey: 'task-a', criterionIndex: 0, result: 'pass', note: 'Verified A' },
    { taskKey: 'task-b', criterionIndex: 0, result: 'pass', note: 'Verified B' }
  ],
  summary: 'Everything meets the contract'
}
const CONTRACT: ObjectiveEnrollmentPayload = {
  objectiveText: 'Implement the requested objective',
  tier: 'standard',
  landingBar: 'files-on-disk',
  maxConcurrency: 1,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

let root: string
let database: ObjectiveDatabase
let store: ObjectiveStore
const opened: ObjectiveDatabase[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-objective-store-'))
  database = new ObjectiveDatabase(':memory:')
  opened.push(database)
  store = new ObjectiveStore(database, () => 9_999)
})

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
  rmSync(root, { recursive: true, force: true })
})

function ingest(revisionNumber = 1, dispatchId = `planner-${revisionNumber}`) {
  return store.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber,
    dispatchId,
    report: REPORT,
    digest: `plan-digest-${revisionNumber}`,
    createdAtMs: 100 + revisionNumber
  })
}

function settledAttempt(
  id: string,
  action: KernelAction,
  effect: NonNullable<AttemptEntry['effect']>,
  result?: unknown
): AttemptEntry {
  return {
    eventId: `event-${id}`,
    watcherId: WATCHER_ID,
    atMs: 1_000,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: id,
    fingerprint: `fingerprint-${id}`,
    action,
    state: 'settled',
    effect,
    ...(result === undefined ? {} : { result })
  }
}

function action(kind: string, extras: Record<string, unknown> = {}): KernelAction {
  return {
    kind,
    capability: kind === 'record-landing' ? 'land' : 'implement',
    visibility: 'local',
    contentIdentity: CONTENT_IDENTITY,
    evidenceKey: `${kind}-evidence`,
    ...extras
  }
}

function rowCounts(): Record<string, number> {
  const result: Record<string, number> = {}
  for (const table of [
    'plan_revision',
    'plan_node',
    'acceptance_criterion',
    'check_attempt',
    'review_verdict',
    'landing_evidence'
  ]) {
    const row = database.connection().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number
    }
    result[table] = row.count
  }
  return result
}

describe('ObjectiveStore natural-key persistence', () => {
  it('replays every v1 table mutation without duplicating a row', () => {
    const revision = ingest()
    expect(ingest()).toEqual(revision)
    expect(() => ingest(2, 'planner-1')).toThrow(/Planner dispatch natural key/)
    expect(store.hasUsablePlan(WATCHER_ID)).toBe(false)
    const activation = {
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    }
    const activated = store.activatePlan(activation)
    expect(store.activatePlan({ ...activation, approvedAtMs: 201 })).toEqual(activated)
    expect(store.isPlanActivated(WATCHER_ID, revision.revisionId, revision.digest)).toBe(true)
    expect(store.hasUsablePlan(WATCHER_ID)).toBe(true)
    expect(store.planForDispatch(WATCHER_ID, 'planner-1')).toEqual({
      revisionId: revision.revisionId,
      revisionNumber: 1,
      digest: revision.digest
    })
    const dispatch = {
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      taskKey: 'task-a',
      orchestrationTaskId: 'orchestration-task-a',
      dispatchId: 'implementer-dispatch-a',
      dispatchedAtMs: 300
    }
    expect(store.recordNodeDispatch(dispatch)).toEqual(store.recordNodeDispatch(dispatch))
    const criterionId = store.project(WATCHER_ID).nodes[0].criteria[0].id
    const started = {
      watcherId: WATCHER_ID,
      criterionId,
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'execution-host-1',
      command: 'pnpm check:a',
      epoch: 4,
      startedAtMs: 400
    }
    expect(store.startCheckAttempt(started)).toEqual(store.startCheckAttempt(started))
    const completed = {
      criterionId,
      contentIdentity: CONTENT_IDENTITY,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'passed',
      stderrTail: '',
      completedAtMs: 450
    }
    expect(store.completeCheckAttempt(completed)).toEqual(store.completeCheckAttempt(completed))
    const verdict = {
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'review-dispatch-1',
      role: 'reviewer' as const,
      contentIdentity: CONTENT_IDENTITY,
      report: REVIEW,
      reportDigest: 'review-digest-1',
      createdAtMs: 500
    }
    expect(store.recordVerdict(verdict)).toEqual(
      store.recordVerdict({ ...verdict, createdAtMs: 501 })
    )
    expect(() => store.recordVerdict({ ...verdict, reportDigest: 'conflicting-digest' })).toThrow(
      /different content/
    )
    const landing = {
      watcherId: WATCHER_ID,
      rung: 'files-on-disk' as const,
      contentIdentity: CONTENT_IDENTITY,
      attemptFingerprint: 'landing-fingerprint-1',
      payload: { revisionId: revision.revisionId },
      epoch: 4,
      createdAtMs: 600
    }
    const landed = store.recordLanding(landing)
    expect(store.recordLanding({ ...landing, epoch: 5, createdAtMs: 601 })).toEqual(landed)
    expect(() =>
      store.recordLanding({ ...landing, attemptFingerprint: 'conflicting-fingerprint' })
    ).toThrow(/different content/)

    expect(rowCounts()).toEqual({
      plan_revision: 1,
      plan_node: 2,
      acceptance_criterion: 2,
      check_attempt: 1,
      review_verdict: 1,
      landing_evidence: 1
    })
    expect(store.getCheckAttempt(criterionId, CONTENT_IDENTITY)?.completedAtMs).toBe(450)
  })

  it('round-trips every landing rung and rejects a changed rich payload replay', () => {
    const revision = ingest()
    const cases: {
      rung: ObjectiveLandingBar
      payload: ObjectiveLandingPayload
    }[] = [
      {
        rung: 'files-on-disk',
        payload: { revisionId: revision.revisionId }
      },
      {
        rung: 'committed-local-branch',
        payload: {
          revisionId: revision.revisionId,
          fromContentIdentity: 'content-before-commit',
          commitSha: 'a'.repeat(40),
          treeOid: 'b'.repeat(40),
          branch: 'feature/objective'
        }
      },
      {
        rung: 'pushed-ref',
        payload: {
          revisionId: revision.revisionId,
          fromContentIdentity: 'content-after-commit',
          remote: 'origin',
          branch: 'feature/objective',
          commitSha: 'a'.repeat(40),
          remoteSha: 'a'.repeat(40)
        }
      },
      {
        rung: 'hosted-review',
        payload: {
          revisionId: revision.revisionId,
          fromContentIdentity: 'content-after-commit',
          provider: 'github',
          reviewNumber: 42,
          reviewUrl: 'https://github.test/acme/repo/pull/42',
          branch: 'feature/objective',
          headSha: 'a'.repeat(40),
          base: 'main'
        }
      },
      {
        rung: 'merged',
        payload: {
          revisionId: revision.revisionId,
          fromContentIdentity: 'content-after-commit',
          mergeSha: 'c'.repeat(40)
        }
      }
    ]

    for (const [index, entry] of cases.entries()) {
      const landing = {
        watcherId: WATCHER_ID,
        rung: entry.rung,
        contentIdentity: `content-${entry.rung}`,
        attemptFingerprint: `landing-fingerprint-${entry.rung}`,
        payload: entry.payload,
        epoch: 4,
        createdAtMs: 600 + index
      }
      const recorded = store.recordLanding(landing)
      expect(store.landingRow(WATCHER_ID, entry.rung, landing.contentIdentity)).toEqual(
        entry.payload
      )
      expect(
        store.recordLanding({
          ...landing,
          payload: structuredClone(entry.payload),
          epoch: 99,
          createdAtMs: 9_999
        })
      ).toEqual(recorded)
    }

    expect(() =>
      store.recordLanding({
        watcherId: WATCHER_ID,
        rung: 'committed-local-branch',
        contentIdentity: 'content-committed-local-branch',
        attemptFingerprint: 'landing-fingerprint-committed-local-branch',
        payload: {
          revisionId: revision.revisionId,
          fromContentIdentity: 'content-before-commit',
          commitSha: 'd'.repeat(40),
          treeOid: 'b'.repeat(40),
          branch: 'feature/objective'
        },
        epoch: 4,
        createdAtMs: 601
      })
    ).toThrow(/different content/)
  })

  it('projects the check for the requested content identity after workspace reversion', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const criterionId = store.project(WATCHER_ID).nodes[0].criteria[0].id
    for (const [contentIdentity, startedAtMs] of [
      [CONTENT_IDENTITY, 300],
      ['newer-content-identity', 400]
    ] as const) {
      store.startCheckAttempt({
        watcherId: WATCHER_ID,
        criterionId,
        contentIdentity,
        executionHostId: 'execution-host-1',
        command: 'pnpm check:a',
        epoch: 4,
        startedAtMs
      })
      store.completeCheckAttempt({
        criterionId,
        contentIdentity,
        exitCode: 0,
        timedOut: false,
        stdoutTail: 'passed',
        stderrTail: '',
        completedAtMs: startedAtMs + 10
      })
    }

    expect(
      store.project(WATCHER_ID, undefined, CONTENT_IDENTITY).nodes[0].criteria[0].lastCheck
        ?.contentIdentity
    ).toBe(CONTENT_IDENTITY)
    expect(
      store.project(WATCHER_ID, undefined, 'never-checked').nodes[0].criteria[0].lastCheck
    ).toBeNull()
  })

  it('permits only one draft revision per watcher', () => {
    const first = ingest()
    expect(() => ingest(2)).toThrow(/UNIQUE constraint failed/)
    expect(store.project(WATCHER_ID).revisions).toHaveLength(1)

    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: first.revisionId,
      digest: first.digest,
      approvedAtMs: 200
    })
    expect(store.hasUsablePlan(WATCHER_ID)).toBe(true)
    expect(() => ingest(2)).not.toThrow()
    expect(store.hasUsablePlan(WATCHER_ID)).toBe(false)
    expect(store.project(WATCHER_ID).revisions.map(({ status }) => status)).toEqual([
      'approved',
      'draft'
    ])
  })

  it('keeps plan, node, and criterion bodies out of the cheap projection', () => {
    const revision = ingest()
    const projection = store.project(WATCHER_ID)
    expect(projection.revisions[0]).not.toHaveProperty('payload')
    expect(projection.nodes[0]).not.toHaveProperty('title')
    expect(projection.nodes[0]).not.toHaveProperty('spec')
    expect(projection.nodes[0].criteria[0]).not.toHaveProperty('body')
    expect(JSON.stringify(projection)).not.toContain('Secret')
    expect(store.getPlan(revision.revisionId)).toEqual(REPORT.plan)
    expect(store.getTask(revision.revisionId, 'task-a')?.spec).toBe(
      'Secret implementer specification A'
    )
    expect(store.getCriterion(projection.nodes[0].criteria[0].id)?.body).toBe(
      'Secret acceptance body A'
    )
  })

  it('refuses malformed persisted JSON instead of returning a partial projection', () => {
    ingest()
    database
      .connection()
      .prepare("UPDATE plan_node SET deps_json = '{}' WHERE task_key = 'task-a'")
      .run()
    expect(() => store.project(WATCHER_ID)).toThrow(/invalid node dependencies/)
  })

  it('maps persisted dispatches and ledger settlements onto node states', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const runningDispatch: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        {
          ...settledAttempt(
            'running',
            action('dispatch-node', {
              revisionId: revision.revisionId,
              taskKey: 'task-a',
              depsOrchestrationIds: []
            }),
            'landed'
          ),
          state: 'running',
          effect: undefined
        }
      ]
    }
    expect(store.project(WATCHER_ID, runningDispatch).nodes[0].state).toBe('dispatched')
    const ledger: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        settledAttempt(
          'success',
          action('ingest-report', {
            revisionId: revision.revisionId,
            taskKey: 'task-a',
            dispatchId: 'dispatch-task-a'
          }),
          'landed'
        ),
        settledAttempt(
          'failure',
          action('dispatch-node', {
            revisionId: revision.revisionId,
            taskKey: 'task-b'
          }),
          'not-landed'
        )
      ]
    }
    expect(store.project(WATCHER_ID, ledger).nodes.map(({ state }) => state)).toEqual([
      'succeeded',
      'failed'
    ])
  })

  it('keeps an infra/environment failure pending under the redispatch cap, but failed past it', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const retryOf = `${revision.revisionId}:task-a`
    const dispatchNode = (extras: Record<string, unknown> = {}) =>
      action('dispatch-node', {
        revisionId: revision.revisionId,
        taskKey: 'task-a',
        depsOrchestrationIds: [],
        ...extras
      })
    const underCap: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        {
          ...settledAttempt('under-cap', dispatchNode(), 'not-landed'),
          failureClass: 'infra'
        }
      ]
    }
    expect(store.project(WATCHER_ID, underCap).nodes[0].state).toBe('pending')

    const pastCap: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [
        {
          ...settledAttempt('original', dispatchNode(), 'not-landed'),
          failureClass: 'infra'
        },
        {
          ...settledAttempt('retry-0', dispatchNode({ retryOf }), 'not-landed'),
          failureClass: 'environment'
        },
        {
          ...settledAttempt('retry-1', dispatchNode({ retryOf }), 'not-landed'),
          failureClass: 'infra'
        }
      ]
    }
    expect(store.project(WATCHER_ID, pastCap).nodes[0].state).toBe('failed')
  })

  it('recognizes only the base evidence key for a dispatch-node awaiting-approval escalation', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const baseKey = `${revision.revisionId}:task-a`

    function pendingApproval(evidenceKey: string): WatcherLedger {
      return {
        watcherId: WATCHER_ID,
        entries: [
          {
            eventId: `escalation-${evidenceKey}`,
            watcherId: WATCHER_ID,
            atMs: 50,
            origin: 'owner',
            class: 'fact',
            kind: 'escalation',
            escalationId: `awaiting-approval:${evidenceKey}`,
            escalationKind: 'awaiting-approval',
            status: 'open',
            foldCount: 1,
            approvalScope: {
              actionKind: 'dispatch-node',
              contentIdentity: CONTENT_IDENTITY,
              evidenceKey
            }
          }
        ]
      }
    }

    expect(store.project(WATCHER_ID, pendingApproval(`${baseKey}:r0`)).nodes[0].state).toBe(
      'pending'
    )
    expect(store.project(WATCHER_ID, pendingApproval(baseKey)).nodes[0].state).toBe(
      'awaiting-approval'
    )
  })

  it('returns schema-valid detail with bodies, checks, verdicts, and landing evidence', () => {
    const revision = ingest()
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const criterionId = store.project(WATCHER_ID).nodes[0].criteria[0].id
    store.startCheckAttempt({
      watcherId: WATCHER_ID,
      criterionId,
      contentIdentity: CONTENT_IDENTITY,
      executionHostId: 'execution-host-1',
      command: 'pnpm check:a',
      epoch: 4,
      startedAtMs: 400
    })
    store.completeCheckAttempt({
      criterionId,
      contentIdentity: CONTENT_IDENTITY,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'passed',
      stderrTail: '',
      completedAtMs: 450
    })
    store.recordVerdict({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'review-dispatch-1',
      role: 'reviewer',
      contentIdentity: CONTENT_IDENTITY,
      report: REVIEW,
      reportDigest: 'review-digest-1',
      createdAtMs: 500
    })
    store.recordLanding({
      watcherId: WATCHER_ID,
      rung: 'files-on-disk',
      contentIdentity: CONTENT_IDENTITY,
      attemptFingerprint: 'landing-fingerprint-1',
      payload: { revisionId: revision.revisionId },
      epoch: 4,
      createdAtMs: 600
    })

    const detail = store.detail(WATCHER_ID, CONTRACT)
    expect(ObjectiveDetailSchema.parse(detail)).toEqual(detail)
    expect(detail.revisions[0].nodeCount).toBe(2)
    expect(detail.nodes[0].criteria[0]).toMatchObject({
      body: 'Secret acceptance body A',
      lastCheck: { exitCode: 0, timedOut: false },
      lastReview: 'pass'
    })
    expect(detail.landing).toEqual([
      { rung: 'files-on-disk', contentIdentity: CONTENT_IDENTITY, atMs: 600 }
    ])
    expect(detail.asOfMs).toBe(9_999)
  })

  it('purges only the selected watcher', () => {
    ingest()
    store.ingestPlan({
      watcherId: 'watcher-objective-2',
      revisionNumber: 1,
      dispatchId: 'other-plan',
      report: REPORT,
      digest: 'other-digest',
      createdAtMs: 100
    })
    store.purge(WATCHER_ID)
    expect(store.project(WATCHER_ID).revisions).toEqual([])
    expect(store.project('watcher-objective-2').revisions).toHaveLength(1)
  })
})

describe('Objective database initialization and recovery', () => {
  it('creates only the v1 objective tables with durable connection settings and POSIX hardening', () => {
    const disk = new ObjectiveDatabase(root)
    opened.push(disk)
    const connection = disk.connection()
    const tables = connection
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as unknown as { name: string }[]
    expect(tables.map(({ name }) => name)).toEqual([
      'acceptance_criterion',
      'check_attempt',
      'landing_evidence',
      'plan_node',
      'plan_revision',
      'review_verdict'
    ])
    expect(connection.pragma('user_version', { simple: true })).toBe(
      OBJECTIVE_DATABASE_SCHEMA_VERSION
    )
    expect(connection.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(connection.pragma('busy_timeout', { simple: true })).toBe(5_000)
    expect(connection.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(connection.pragma('synchronous', { simple: true })).toBe(2)
    if (process.platform !== 'win32') {
      expect(statSync(disk.databasePath()).mode & 0o777).toBe(0o600)
    }
  })

  it('opens a future schema read-only without downgrading it', () => {
    const path = join(root, 'fork-heimdall-objective', 'objective.db')
    mkdirSync(join(root, 'fork-heimdall-objective'), { recursive: true })
    const future = new Database(path)
    future.pragma(`user_version = ${OBJECTIVE_DATABASE_SCHEMA_VERSION + 1}`)
    future.close()
    const disk = new ObjectiveDatabase(root)
    opened.push(disk)
    const futureStore = new ObjectiveStore(disk)

    expect(disk.isReadOnly()).toBe(true)
    expect(disk.connection().pragma('user_version', { simple: true })).toBe(
      OBJECTIVE_DATABASE_SCHEMA_VERSION + 1
    )
    expect(() => futureStore.purge(WATCHER_ID)).toThrow(/read-only/)
  })

  it('reconciles only settled landed mutations whose ledger data is complete', () => {
    const revision = ingest()
    const dispatchId = 'reconciled-dispatch'
    const dispatched = {
      ...settledAttempt(
        'dispatch',
        action('dispatch-node', {
          revisionId: revision.revisionId,
          taskKey: 'task-a',
          depsOrchestrationIds: []
        }),
        'landed'
      ),
      atMs: 900,
      dispatchId
    } satisfies AttemptEntry
    const reconstructible = settledAttempt(
      'report',
      action('ingest-report', {
        recovery: 'replay-safe',
        revisionId: revision.revisionId,
        dispatchId,
        taskKey: 'task-a',
        orchestrationTaskId: 'orchestration-task-recovered',
        reportPath: '/issued/objective-report.json',
        filesModified: ['src/a.ts'],
        dispatchedContentIdentity: CONTENT_IDENTITY
      }),
      'landed',
      {
        kind: 'report-ingested',
        naturalKey: {
          kind: 'implementer-report',
          revisionId: revision.revisionId,
          taskKey: 'task-a',
          dispatchId
        },
        digest: 'report-digest'
      }
    )
    const incomplete = settledAttempt(
      'landing',
      action('record-landing', {
        recovery: 'replay-safe',
        rung: 'files-on-disk',
        revisionId: revision.revisionId
      }),
      'landed',
      {
        kind: 'landing-recorded',
        naturalKey: {
          kind: 'landing-evidence',
          rung: 'files-on-disk',
          contentIdentity: CONTENT_IDENTITY
        },
        digest: 'landing-digest'
      }
    )
    const notLanded = settledAttempt(
      'not-landed',
      action('record-landing', {
        recovery: 'replay-safe',
        rung: 'files-on-disk',
        revisionId: 'ignored-revision'
      }),
      'not-landed'
    )
    const ledger: WatcherLedger = {
      watcherId: WATCHER_ID,
      entries: [dispatched, reconstructible, incomplete, notLanded]
    }

    expect(store.reconcile(ledger)).toEqual({ reconciled: 1, skipped: 1 })
    expect(store.nodeForDispatch(WATCHER_ID, dispatchId)).toEqual({
      revisionId: revision.revisionId,
      taskKey: 'task-a'
    })
    expect(store.project(WATCHER_ID).nodes.map(({ state }) => state)).toEqual([
      'succeeded',
      'pending'
    ])
    expect(store.hasLanding(WATCHER_ID, 'files-on-disk', CONTENT_IDENTITY)).toBe(false)
    expect(store.reconcile(ledger)).toEqual({ reconciled: 0, skipped: 1 })
  })
})
