import type { ObjectiveEnrollmentPayload } from '../../shared/fork-heimdall-objective/contract-types'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import type { AttemptEntry, KernelAction } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveStore } from './objective-store'

export const WATCHER_ID = 'watcher-objective-1'
export const CONTENT_IDENTITY = 'content-identity-1'

export const REPORT: PlannerReport = {
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

export const CONTRACT: ObjectiveEnrollmentPayload = {
  objectiveText: 'Implement the requested objective',
  tier: 'standard',
  landingBar: 'files-on-disk',
  maxConcurrency: 1,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

export function ingest(
  store: ObjectiveStore,
  revisionNumber = 1,
  dispatchId = `planner-${revisionNumber}`
) {
  return store.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber,
    dispatchId,
    report: REPORT,
    digest: `plan-digest-${revisionNumber}`,
    createdAtMs: 100 + revisionNumber
  })
}

export function settledAttempt(
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

export function action(kind: string, extras: Record<string, unknown> = {}): KernelAction {
  return {
    kind,
    capability: kind === 'record-landing' ? 'land' : 'implement',
    visibility: 'local',
    contentIdentity: CONTENT_IDENTITY,
    evidenceKey: `${kind}-evidence`,
    ...extras
  }
}
