import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import { computeWorkspaceContentIdentity } from './content-identity'
import { ObjectiveDatabase } from './objective-database'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { executeObjectiveLocalAction } from './local-action-executor'
import { issueObjectiveReportPath } from './report-ingestion'
import { ObjectiveStore } from './objective-store'

const WATCHER_ID = 'watcher-1'

const PLAN: PlannerReport = {
  plan: [
    {
      taskKey: 'node-1',
      title: 'Node 1',
      spec: 'Execute node one',
      deps: [],
      criteria: [
        {
          body: 'The workspace check passes',
          shellCheckable: true,
          checkCommand: 'true'
        }
      ],
      declaresDependencyChange: false
    }
  ]
}

const opened: ObjectiveDatabase[] = []

afterEach(() => {
  for (const item of opened) {
    item.close()
  }
  opened.length = 0
})

type ObjectiveStoreFixture = {
  objectiveStore: ObjectiveStore
  revisionId: string
  criterionId: string
}

function objectiveStoreFixture(): ObjectiveStoreFixture {
  const database = new ObjectiveDatabase(':memory:')
  opened.push(database)
  const objectiveStore = new ObjectiveStore(database)
  const revision = objectiveStore.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber: 1,
    dispatchId: 'planner-1',
    report: PLAN,
    digest: 'digest-1',
    createdAtMs: 1
  })
  objectiveStore.activatePlan({
    watcherId: WATCHER_ID,
    revisionId: revision.revisionId,
    digest: revision.digest,
    approvedAtMs: 2
  })
  const node = objectiveStore.project(WATCHER_ID).nodes[0]
  const criterion = node?.criteria[0]
  if (!node || !criterion) {
    throw new Error('Objective fixture did not create a criterion')
  }
  objectiveStore.recordNodeDispatch({
    watcherId: WATCHER_ID,
    revisionId: revision.revisionId,
    taskKey: node.taskKey,
    orchestrationTaskId: 'orchestration-node-1',
    dispatchId: 'dispatch-node-1',
    dispatchedAtMs: 3
  })
  return {
    objectiveStore,
    revisionId: revision.revisionId,
    criterionId: criterion.id
  }
}

function seedCompletedCheck(fixture: ObjectiveStoreFixture, contentIdentity: string): void {
  fixture.objectiveStore.startCheckAttempt({
    watcherId: WATCHER_ID,
    criterionId: fixture.criterionId,
    contentIdentity,
    executionHostId: 'local',
    command: 'true',
    epoch: 1,
    startedAtMs: 4
  })
  fixture.objectiveStore.completeCheckAttempt({
    criterionId: fixture.criterionId,
    contentIdentity,
    exitCode: 0,
    timedOut: false,
    stdoutTail: '',
    stderrTail: '',
    completedAtMs: 5
  })
}

const action = (contentIdentity: string, revisionId: string): ObjectiveAction => ({
  kind: 'record-landing',
  capability: 'land',
  visibility: 'local',
  contentIdentity,
  evidenceKey: `files-on-disk:${contentIdentity}`,
  recovery: 'replay-safe',
  rung: 'files-on-disk',
  revisionId
})

describe('objective landing execution', () => {
  it('refuses to persist landing evidence after the workspace identity changes', async () => {
    const fixture = objectiveStoreFixture()
    const workspacePath = await mkdtemp(join(tmpdir(), 'objective-landing-'))
    try {
      await writeFile(join(workspacePath, 'result.txt'), 'before')
      const target = {
        kind: 'folder' as const,
        executionHostId: 'local' as const,
        workspacePath,
        fileProvider: null
      }
      const contentIdentity = await computeWorkspaceContentIdentity(target)
      seedCompletedCheck(fixture, contentIdentity)
      await writeFile(join(workspacePath, 'result.txt'), 'after with a different size')
      const binding = {
        enrollment: { watcherId: WATCHER_ID },
        contract: { tier: 'express' },
        target
      } as unknown as ObjectiveSnapshotBinding
      const context = {
        snapshot: { contentIdentity },
        ledger: { watcherId: WATCHER_ID, entries: [] },
        lease: { assertHeld: vi.fn(async () => undefined) },
        dispatchWorker: vi.fn()
      } as unknown as ExecuteContext<ObjectiveWorld>

      await expect(
        executeObjectiveLocalAction({
          action: action(contentIdentity, fixture.revisionId) as Extract<
            ObjectiveAction,
            { kind: 'record-landing' }
          >,
          binding,
          context,
          objectiveStore: fixture.objectiveStore
        })
      ).resolves.toEqual({ effect: 'not-landed', reason: 'landing-evidence-stale' })
      expect(fixture.objectiveStore.hasLanding(WATCHER_ID, 'files-on-disk', contentIdentity)).toBe(
        false
      )
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })

  it('re-reads identity-scoped checks instead of trusting the decision snapshot', async () => {
    const fixture = objectiveStoreFixture()
    const workspacePath = await mkdtemp(join(tmpdir(), 'objective-landing-check-'))
    try {
      const target = {
        kind: 'folder' as const,
        executionHostId: 'local' as const,
        workspacePath,
        fileProvider: null
      }
      const contentIdentity = await computeWorkspaceContentIdentity(target)
      seedCompletedCheck(fixture, `other-${contentIdentity}`)
      const binding = {
        enrollment: { watcherId: WATCHER_ID },
        contract: { tier: 'express' },
        target
      } as unknown as ObjectiveSnapshotBinding
      const context = {
        snapshot: { contentIdentity },
        ledger: { watcherId: WATCHER_ID, entries: [] },
        lease: { assertHeld: vi.fn(async () => undefined) },
        dispatchWorker: vi.fn()
      } as unknown as ExecuteContext<ObjectiveWorld>

      await expect(
        executeObjectiveLocalAction({
          action: action(contentIdentity, fixture.revisionId) as Extract<
            ObjectiveAction,
            { kind: 'record-landing' }
          >,
          binding,
          context,
          objectiveStore: fixture.objectiveStore
        })
      ).resolves.toEqual({ effect: 'not-landed', reason: 'landing-evidence-stale' })
      expect(fixture.objectiveStore.hasLanding(WATCHER_ID, 'files-on-disk', contentIdentity)).toBe(
        false
      )
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })
})

describe('objective report ingestion execution', () => {
  it('returns planner schema detail without persisting a malformed plan', async () => {
    const database = new ObjectiveDatabase(':memory:')
    opened.push(database)
    const objectiveStore = new ObjectiveStore(database)
    const workspacePath = await mkdtemp(join(tmpdir(), 'objective-plan-ingestion-'))
    try {
      const target = {
        kind: 'folder' as const,
        executionHostId: 'local' as const,
        workspacePath,
        fileProvider: null
      }
      const dispatchAction = {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'revision-1',
        revisionNumber: 1,
        reason: 'initial'
      } satisfies ObjectiveAction
      const fingerprint = makeAttemptFingerprint(
        dispatchAction.contentIdentity,
        dispatchAction.kind,
        dispatchAction.evidenceKey
      )
      const reportPath = await issueObjectiveReportPath(target, fingerprint)
      await writeFile(
        reportPath,
        JSON.stringify({
          plan: [
            {
              taskKey: 'node-1',
              title: 'Node 1',
              spec: 'Execute node one',
              deps: [],
              criteria: [{ body: 'Node works', shellCheckable: false, checkCommand: null }],
              declaresDependencyChange: false,
              declaredPaths: ['src/**']
            }
          ]
        })
      )
      const ingestAction = {
        kind: 'ingest-plan',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: 'content-1',
        evidenceKey: 'revision-1',
        recovery: 'replay-safe',
        dispatchId: 'dispatch-planner-1',
        revisionNumber: 1,
        reportPath
      } satisfies ObjectiveAction
      const binding = {
        enrollment: { watcherId: WATCHER_ID },
        contract: { writeTerritory: ['src/**'] },
        target
      } as unknown as ObjectiveSnapshotBinding
      const context = {
        snapshot: { contentIdentity: 'content-1' },
        ledger: {
          watcherId: WATCHER_ID,
          entries: [
            {
              eventId: 'attempt-planner-1',
              watcherId: WATCHER_ID,
              atMs: 1,
              origin: 'owner',
              class: 'fact',
              kind: 'attempt',
              attemptId: 'attempt-planner-1',
              fingerprint,
              action: dispatchAction,
              state: 'settled',
              effect: 'indeterminate',
              dispatch: {
                spec: 'Plan the objective.',
                deps: [],
                dispatchKind: 'planner'
              },
              dispatchId: 'dispatch-planner-1'
            },
            {
              eventId: 'evidence-planner-1',
              watcherId: WATCHER_ID,
              atMs: 2,
              origin: 'owner',
              class: 'fact',
              kind: 'evidence',
              evidenceKind: 'orchestration-mailbox',
              payload: {
                type: 'worker_done',
                payload: {
                  dispatchId: 'dispatch-planner-1',
                  outcome: 'succeeded',
                  reportPath,
                  filesModified: []
                }
              }
            }
          ]
        },
        lease: { assertHeld: vi.fn(async () => undefined) },
        dispatchWorker: vi.fn()
      } as unknown as ExecuteContext<ObjectiveWorld>

      await expect(
        executeObjectiveLocalAction({
          action: ingestAction,
          binding,
          context,
          objectiveStore
        })
      ).resolves.toEqual({
        effect: 'not-landed',
        reason: 'planner-report-malformed',
        result: {
          detail: 'plan[0].declaredPaths[0]: Path must be a concrete workspace-relative path'
        }
      })
      expect(objectiveStore.project(WATCHER_ID).revisions).toEqual([])
    } finally {
      await rm(workspacePath, { recursive: true, force: true })
    }
  })
})
