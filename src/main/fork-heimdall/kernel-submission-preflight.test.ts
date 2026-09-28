import { describe, expect, it } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'
import { preflightKernelSubmission } from './kernel-submission-preflight'
import {
  ownerInterventionSubmissionSubject,
  recordDeviation,
  type DeviationRecordDependencies
} from './owner/deviation-ledger'

const WATCHER_ID = 'watcher-1'
const RUN_ID = 'run-1'

function fixture(): {
  deps: Parameters<typeof preflightKernelSubmission>[1]
  ledgerRecord: DeviationRecordDependencies
} {
  const entries: LedgerEntry[] = []
  const ledgerStore: RunnerLedgerStore = {
    read(watcherId: string): WatcherLedger {
      return { watcherId, entries }
    },
    append(_watcherId: string, entry: LedgerEntry): void {
      entries.push(entry)
    },
    appendTickTrace: () => undefined,
    readTickTraces: () => [],
    releaseTickTracePin: () => undefined,
    readTerminalSummary: () => null
  }
  const enrollment: WatcherEnrollment = {
    watcherId: WATCHER_ID,
    kind: 'objective',
    workspaceKey: 'local::/workspace',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath: '/workspace',
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'coordinator-pane' },
    orchestrationRunId: RUN_ID,
    createdAtMs: 1,
    terminalAtMs: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests only reach runner.kind.owner/kind.submission; WatcherRunner's scheduler-loop state and kind.read/kind.decide surface are unused here.
  const runner = {
    kind: { owner: {} }
  } as unknown as WatcherRunner

  return {
    deps: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only list() is called by preflightKernelSubmission; EnrollmentStore's other ~12 persistence methods are unused here.
      enrollments: { list: () => [enrollment] } as never,
      runners: new Map([[WATCHER_ID, runner]]),
      ledgerStore,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every case here returns before reaching deps.host.resolveLeaseTarget, so HeimdallKernelHost's whole surface is unused.
      host: {} as never,
      ownsEnrollment: () => true
    },
    ledgerRecord: {
      ledgerStore,
      now: () => 1,
      createId: () => 'occurrence-1'
    }
  }
}

describe('preflightKernelSubmission owner ready lifecycle', () => {
  it('rejects the exact reserved ready subject before its owner turn has been sent', async () => {
    const { deps, ledgerRecord } = fixture()
    const pending = recordDeviation(ledgerRecord, WATCHER_ID, {
      kind: 'plan-failed',
      reason: 'no-usable-plan'
    })

    const result = await preflightKernelSubmission(
      {
        runId: RUN_ID,
        from: 'future-owner-handle',
        type: 'status',
        subject: ownerInterventionSubmissionSubject(WATCHER_ID, pending),
        body: 'ready'
      },
      deps
    )

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'heimdall_owner_turn_not_active'
    })
  })

  it('rejects a reserved ready subject when no matching owner turn exists', async () => {
    const { deps } = fixture()

    const result = await preflightKernelSubmission(
      {
        runId: RUN_ID,
        from: 'unrelated-handle',
        type: 'status',
        subject: `heimdall-owner-intervention:${WATCHER_ID}:stale-wake`,
        body: 'ready'
      },
      deps
    )

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'heimdall_owner_turn_not_active'
    })
  })

  it('leaves non-reserved status subjects outside owner intervention preflight', async () => {
    const { deps } = fixture()

    await expect(
      preflightKernelSubmission(
        {
          runId: RUN_ID,
          from: 'worker-handle',
          type: 'status',
          subject: 'ordinary-worker-status',
          body: 'working'
        },
        deps
      )
    ).resolves.toEqual({ status: 'accepted' })
  })
})
