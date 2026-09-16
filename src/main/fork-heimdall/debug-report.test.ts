import { describe, expect, it } from 'vitest'
import type {
  EscalationEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { createTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  DEBUG_REPORT_TRACE_LIMIT,
  buildHeimdallDebugReport,
  describeDebugSnapshot,
  dormantWatcherStatus,
  type HeimdallDebugReportInput
} from './debug-report'

const HOME = '/Users/someone'

function enrollment(overrides: Partial<WatcherEnrollment> = {}): WatcherEnrollment {
  return {
    watcherId: 'watcher-1',
    kind: 'hosted-review',
    workspaceKey: 'local::/Users/someone/work/orca',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: `${HOME}/work/orca`,
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { write: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 4 },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'tab:leaf' },
    orchestrationRunId: null,
    createdAtMs: 100,
    terminalAtMs: null,
    ...overrides
  }
}

function ledger(entries: LedgerEntry[] = []): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

function escalation(
  escalationKind: string,
  overrides: Partial<EscalationEntry> = {}
): EscalationEntry {
  return {
    eventId: `event-${escalationKind}`,
    watcherId: 'watcher-1',
    atMs: 200,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: `${escalationKind}:watcher-1`,
    escalationKind,
    status: 'open',
    foldCount: 1,
    ...overrides
  }
}

function reportInput(overrides: Partial<HeimdallDebugReportInput> = {}): HeimdallDebugReportInput {
  const watcher = enrollment()
  const watcherLedger = ledger()
  return {
    enrollment: watcher,
    status: dormantWatcherStatus(watcher, watcherLedger),
    ledger: watcherLedger,
    traces: [],
    runner: null,
    generatedAtMs: 300,
    appVersion: '1.4.204',
    platform: 'darwin',
    homeDirectory: HOME,
    budgetClock: { openIntervalId: null },
    malformedPayload: false,
    pendingControlOperation: false,
    workers: [],
    workersError: null,
    pointers: [],
    ...overrides
  }
}

describe('dormant Heimdall watcher status', () => {
  it('gives a terminal ledger fact precedence over pause and park state', () => {
    const watcher = enrollment({ enabled: false, paused: true, terminalAtMs: 250 })
    const status = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-budget'),
        {
          eventId: 'terminal',
          watcherId: 'watcher-1',
          atMs: 250,
          origin: 'owner',
          class: 'fact',
          kind: 'terminal',
          state: 'completed',
          reason: 'objective-complete'
        }
      ])
    )

    expect(status).toMatchObject({
      state: 'terminal',
      phase: 'terminal',
      reason: 'objective-complete'
    })
  })

  it('reconstructs a worker-question park from the latest open escalation', () => {
    const watcher = enrollment({ enabled: false })
    const status = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('worker-question', {
          escalationId: 'worker-question:dispatch-1:message-7',
          atMs: 199
        }),
        escalation('park-worker-question', {
          escalationId: 'park:watcher-1:worker-question:message-7'
        })
      ])
    )

    expect(status).toMatchObject({
      state: 'parked',
      parkReason: { kind: 'worker-question', messageId: 'message-7' }
    })
  })

  it('uses encoded and legacy reason detail for stop-predicate parks', () => {
    const watcher = enrollment({ enabled: false })
    const encoded = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-stop-predicate', {
          escalationId: 'park:watcher-1:stop-predicate:review%2Dmerged',
          reason: 'The review merged'
        })
      ])
    )
    const legacy = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-stop-predicate', {
          escalationId: 'legacy-park-row',
          reason: 'legacy-predicate'
        })
      ])
    )

    expect(encoded.parkReason).toEqual({
      kind: 'stop-predicate',
      predicateId: 'review-merged',
      reason: 'The review merged'
    })
    expect(legacy.parkReason).toEqual({
      kind: 'stop-predicate',
      predicateId: 'legacy-predicate',
      reason: 'legacy-predicate'
    })
  })

  it('keeps an automatic park visible even when its persisted reason cannot be reconstructed', () => {
    const watcher = enrollment({ enabled: false })
    const status = dormantWatcherStatus(
      watcher,
      ledger([
        escalation('park-budget', {
          escalationId: 'park:watcher-1:budget:unknown-exhaustion'
        })
      ])
    )

    expect(status).toMatchObject({
      state: 'parked',
      reason: 'ready-to-resume',
      parkReason: null
    })
  })

  it('distinguishes enabled and manually disabled dormant watchers', () => {
    expect(dormantWatcherStatus(enrollment(), ledger())).toMatchObject({ state: 'watching' })
    expect(dormantWatcherStatus(enrollment({ enabled: false }), ledger())).toMatchObject({
      state: 'disabled',
      parkReason: null
    })
  })
})

describe('Heimdall debug report', () => {
  it('emits schema 2, sanitizes free text, and leaves pointer paths authoritative', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const failingTrace = createTickTrace(1, 100, {
      consecutiveErrors: 1,
      lastFullResyncAtMs: null,
      reconcileAgain: false
    })
    failingTrace.error = { message: `token=${secret} at ${HOME}/work/orca` }
    const report = buildHeimdallDebugReport(
      reportInput({
        ledger: ledger([
          escalation('awaiting-approval', {
            reason: `token=${secret} at ${HOME}/work/orca`
          })
        ]),
        traces: [failingTrace],
        workersError: `worker failed with token=${secret}`,
        pointers: [
          {
            role: 'workspace',
            host: 'local',
            path: `${HOME}/work/orca`,
            status: 'resolved'
          }
        ]
      })
    )

    expect(report.schemaVersion).toBe(2)
    expect(report.ledger.entries[0]).not.toMatchObject({ reason: expect.stringContaining(secret) })
    expect(report.traces[0]?.error?.message).not.toContain(secret)
    expect(report.workersError).not.toContain(secret)
    expect(report.pointers[0]?.path).toBe(`${HOME}/work/orca`)
  })

  it('collapses only local enrollment paths against the reporting kernel home', () => {
    const local = buildHeimdallDebugReport(reportInput())
    const remoteEnrollment = enrollment({
      executionHostId: 'ssh:build-host',
      workspaceKey: 'ssh:build-host::/Users/someone/work/orca'
    })
    const remote = buildHeimdallDebugReport(reportInput({ enrollment: remoteEnrollment }))

    expect(local.enrollment.workspacePath).toBe('~/work/orca')
    expect(remote.enrollment.workspacePath).toBe(`${HOME}/work/orca`)
  })

  it('retains snapshot envelope diagnostics when a kind description throws', () => {
    const snapshot: Snapshot<unknown> = {
      freshness: 'cached',
      observedAtMs: 123,
      contentIdentity: 'content-1',
      world: { sensitive: 'not returned' }
    }

    expect(
      describeDebugSnapshot(snapshot, () => {
        throw new Error('description failed')
      })
    ).toEqual({
      freshness: 'cached',
      observedAtMs: 123,
      contentIdentity: 'content-1',
      summary: null
    })
  })
  it('keeps only the newest full-detail trace window', () => {
    const traces = Array.from({ length: DEBUG_REPORT_TRACE_LIMIT + 3 }, (_unused, index) =>
      createTickTrace(index + 1, index + 1, {
        consecutiveErrors: 0,
        lastFullResyncAtMs: null,
        reconcileAgain: false
      })
    )

    const report = buildHeimdallDebugReport(reportInput({ traces }))

    expect(report.traces.map((trace) => trace.seq)).toEqual([8, 7, 6, 5, 4])
  })
})
