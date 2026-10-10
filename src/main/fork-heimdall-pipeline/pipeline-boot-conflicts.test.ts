import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WorkspaceKeySchema,
  type WatcherEnrollment
} from '../../shared/fork-heimdall/watcher-types'
import { HeimdallDatabase } from '../fork-heimdall/database'
import { HeimdallEnrollmentStore } from '../fork-heimdall/enrollment-store'
import { HeimdallLedgerStore } from '../fork-heimdall/ledger-store'
import { runnerLedgerStore } from '../fork-heimdall/kernel-service-dependencies'
import { PIPELINE_ENROLLMENT_TABLES } from './pipeline-enrollment-table'
import { PipelineAwareEnrollmentStore } from './pipeline-aware-enrollment-store'
import {
  createPipelineBootConflictParker,
  parkClaimedPipelineRows
} from './pipeline-boot-conflicts'

let root: string
let database: HeimdallDatabase
let enrollments: PipelineAwareEnrollmentStore

function enrollment(
  watcherId: string,
  kind: WatcherEnrollment['kind'],
  workspaceKey: string
): WatcherEnrollment {
  const checkedWorkspaceKey = WorkspaceKeySchema.parse(workspaceKey)
  const workspacePath = checkedWorkspaceKey.slice(checkedWorkspaceKey.indexOf('::') + 2)
  return {
    watcherId,
    kind,
    workspaceKey: checkedWorkspaceKey,
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath,
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: {},
    budget: { wallClockActiveMs: 60_000, turns: 2 },
    kindPayload: {},
    coordinatorIdentity: { handle: `${watcherId}-coordinator`, paneKey: `${watcherId}-pane` },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-heimdall-pipeline-conflict-'))
  database = new HeimdallDatabase(root)
  enrollments = new PipelineAwareEnrollmentStore(database)
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('pipeline boot workspace conflicts', () => {
  it('durably parks overlapping pipeline rows once with the built-in watcher identity', () => {
    const workspace = 'local::/shared-workspace'
    const builtin = new HeimdallEnrollmentStore(database)
    const pipeline = new HeimdallEnrollmentStore(database, PIPELINE_ENROLLMENT_TABLES)
    builtin.insert(enrollment('objective-owner', 'objective', workspace))
    pipeline.insert(enrollment('pipeline-conflict', 'pipeline', workspace))

    const ledger = runnerLedgerStore(new HeimdallLedgerStore(database))
    let event = 0
    const parkForConfigurationError = createPipelineBootConflictParker({
      enrollments,
      ledger,
      now: () => 10,
      createId: () => `park-event-${++event}`
    })

    parkClaimedPipelineRows(enrollments, parkForConfigurationError)
    const parked = enrollments.get('pipeline-conflict')
    expect(parked).toMatchObject({ enabled: false })
    expect(ledger.read('pipeline-conflict').entries).toMatchObject([
      {
        kind: 'escalation',
        escalationKind: 'park-configuration-error',
        status: 'open',
        reason: 'workspace-claimed:objective-owner'
      }
    ])

    parkClaimedPipelineRows(enrollments, parkForConfigurationError)
    expect(ledger.read('pipeline-conflict').entries).toHaveLength(1)
  })
})
