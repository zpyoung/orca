import { vi } from 'vitest'
import { pipelineContentHash } from '../../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import {
  PipelineDocumentSchema,
  type PipelineDocument
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import { makePipelineNodeEvidenceKey } from '../../../shared/fork-heimdall-pipeline/choice-types'
import {
  PipelineRunViewSchema,
  type PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import { WatcherLedgerSchema, type WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import {
  HeimdallFleetSnapshotReaderSchema,
  type WatcherFleetEntryReader
} from '../../../shared/fork-heimdall/remote-reader-schemas'

export const worktreeId = 'repo-canvas::/repo-canvas'
export const repoPipelineId = 'bugfix'

export function runCanvasDocument(): PipelineDocument {
  return {
    version: 1,
    id: repoPipelineId,
    name: 'Saved Bugfix',
    inputs: { task: { type: 'text', required: true, default: 'Repair the issue' } },
    defaults: { harness: 'codex' },
    nodes: [{ id: 'fix', type: 'agent', harness: 'codex', prompt: 'Fix the issue' }]
  }
}

export function pipelineRunRow(
  watcherId: string,
  revision: number,
  readOnly = false
): WatcherFleetEntryReader {
  const base = buildWatcherFleetEntry(revision, 100, watcherId)
  const workspaceKey = `local::${worktreeId}`
  const snapshot = HeimdallFleetSnapshotReaderSchema.parse({
    entries: [
      {
        ...base,
        target: { watcherId, connectionId: null, pairingRevision: null },
        ownerFence: {
          executionHostId: 'local',
          schedulerOwner: 'local_host_service',
          workspaceKey,
          revision
        },
        contact: readOnly ? 'unverifiable' : 'live',
        readOnlyReason: readOnly ? 'The workspace owner is unavailable.' : null,
        entry: {
          ...base.entry,
          enrollment: {
            ...base.entry.enrollment,
            watcherId,
            kind: 'pipeline',
            workspaceKey,
            executionHostId: 'local',
            repoId: 'repo-canvas',
            worktreeId,
            workspacePath: '/repo-canvas',
            schedulerOwner: 'local_host_service',
            capabilities: { agent: 'gated' },
            kindPayload: { schemaVersion: 1 }
          },
          status: { ...base.entry.status, watcherId }
        }
      }
    ],
    generatedAtMs: 100
  })
  const row = snapshot.entries[0]
  if (!row) {
    throw new Error('The pipeline fleet fixture has no watcher row.')
  }
  return row
}

export function pinnedRunView(watcherId: string, runNumber: number): PipelineRunView {
  const document = PipelineDocumentSchema.parse(
    runNumber === 12
      ? {
          version: 1,
          id: repoPipelineId,
          name: 'Pinned Bugfix 12',
          inputs: {},
          defaults: { harness: 'codex' },
          nodes: [
            { id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the fix' },
            {
              id: 'approve',
              type: 'gate',
              label: 'Review run 12',
              after: ['build'],
              sendBackTo: 'build'
            }
          ]
        }
      : {
          version: 1,
          id: repoPipelineId,
          name: 'Pinned Bugfix 11',
          inputs: {},
          defaults: { harness: 'codex' },
          nodes: [
            {
              id: 'fix',
              type: 'agent',
              label: 'Pinned run 11 source',
              harness: 'codex',
              prompt: 'Fix from run 11'
            }
          ]
        }
  )
  const nodes =
    runNumber === 12
      ? [
          {
            instanceId: 'build',
            nodeId: 'build',
            type: 'agent',
            label: 'Completed run 12 build',
            status: 'done',
            epoch: 0,
            attempt: 1,
            turns: 0
          },
          {
            instanceId: 'approve',
            nodeId: 'approve',
            type: 'gate',
            label: 'Review run 12',
            status: 'waiting',
            waitingFor: 'gate',
            escalationId: `escalation-${watcherId}`,
            epoch: 0,
            attempt: 1,
            turns: 0
          }
        ]
      : [
          {
            instanceId: 'fix',
            nodeId: 'fix',
            type: 'agent',
            label: 'Pinned run 11 source',
            status: 'done',
            epoch: 0,
            attempt: 1,
            turns: 0
          }
        ]
  return PipelineRunViewSchema.parse({
    watcherId,
    kind: 'pipeline',
    pin: {
      ref: repoPipelineId,
      scope: 'repo',
      id: repoPipelineId,
      contentHash: pipelineContentHash(document),
      documentVersion: 1,
      runNumber,
      label: `Bugfix run ${runNumber}`
    },
    document,
    nodes,
    edges: runNumber === 12 ? [{ from: 'build', to: 'approve' }] : [],
    asOfMs: 100
  })
}

export function ledgerForRun(view: PipelineRunView): WatcherLedger {
  if (view.pin.runNumber !== 12) {
    return WatcherLedgerSchema.parse({ watcherId: view.watcherId, entries: [] })
  }
  return WatcherLedgerSchema.parse({
    watcherId: view.watcherId,
    entries: [
      {
        eventId: `event-${view.watcherId}`,
        watcherId: view.watcherId,
        atMs: 10,
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        escalationId: `escalation-${view.watcherId}`,
        escalationKind: 'awaiting-approval',
        status: 'open',
        foldCount: 1,
        approvalScope: {
          actionKind: 'pipeline-pass-gate',
          contentIdentity: `pipeline:${view.pin.contentHash}`,
          evidenceKey: makePipelineNodeEvidenceKey({
            instanceId: 'approve',
            epoch: 0,
            attempt: 1,
            cause: 'gate'
          })
        }
      }
    ]
  })
}

export const canvasRunApi = { command: vi.fn() }

export function installCanvasRunApi(
  rows: readonly WatcherFleetEntryReader[],
  views: ReadonlyMap<string, PipelineRunView>
): void {
  const snapshot = HeimdallFleetSnapshotReaderSchema.parse({ entries: rows, generatedAtMs: 100 })
  const ledgers = new Map([...views.values()].map((view) => [view.watcherId, ledgerForRun(view)]))
  canvasRunApi.command.mockReset().mockResolvedValue({ status: 'applied', appliedAtMs: 100 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      heimdall: {
        enroll: vi.fn(),
        onFleetChanged: () => () => undefined,
        pipelineList: async () => ({
          pipelines: [
            {
              ref: repoPipelineId,
              scope: 'repo',
              id: repoPipelineId,
              name: 'Bugfix',
              valid: true,
              errorCount: 0,
              contentHash: pipelineContentHash(runCanvasDocument()),
              liveRuns: [...views.values()].map((view) => ({
                watcherId: view.watcherId,
                runNumber: view.pin.runNumber,
                contentHash: view.pin.contentHash
              }))
            }
          ]
        }),
        fleet: async () => snapshot,
        pipelineRunView: async ({ watcherId }: { watcherId: string }) => {
          const view = views.get(watcherId)
          if (!view) {
            throw new Error(`Run ${watcherId} is missing.`)
          }
          return view
        },
        detail: async ({ watcherId }: { watcherId: string }) => ({
          ledger: ledgers.get(watcherId)
        }),
        command: canvasRunApi.command
      }
    }
  })
}
