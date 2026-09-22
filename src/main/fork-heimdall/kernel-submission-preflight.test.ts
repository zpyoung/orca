import { describe, expect, it } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { WatcherRunner } from './runner-state'
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
  const ledgerStore = {
    read(watcherId: string): WatcherLedger {
      return { watcherId, entries }
    },
    append(_watcherId: string, entry: LedgerEntry): void {
      entries.push(entry)
    }
  }
  const enrollment = {
    watcherId: WATCHER_ID,
    orchestrationRunId: RUN_ID,
    terminalAtMs: null
  } as unknown as WatcherEnrollment
  const runner = {
    kind: { owner: {} }
  } as unknown as WatcherRunner

  return {
    deps: {
      enrollments: { list: () => [enrollment] } as never,
      runners: new Map([[WATCHER_ID, runner]]),
      ledgerStore: ledgerStore as never,
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
