import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'
import {
  action,
  CONTENT_IDENTITY,
  ingest as sharedIngest,
  settledAttempt,
  WATCHER_ID
} from './objective-store-test-fixtures'

let database: ObjectiveDatabase
let store: ObjectiveStore
const opened: ObjectiveDatabase[] = []

beforeEach(() => {
  database = new ObjectiveDatabase(':memory:')
  opened.push(database)
  store = new ObjectiveStore(database, () => 9_999)
})

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
})

function ingest(revisionNumber = 1, dispatchId = `planner-${revisionNumber}`) {
  return sharedIngest(store, revisionNumber, dispatchId)
}

describe('Objective store recovery', () => {
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
