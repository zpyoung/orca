import { describe, expect, it } from 'vitest'
import type { WatcherDetail } from '../../shared/fork-heimdall/fleet-types'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import { makePipelineNodeEvidenceKey } from '../../shared/fork-heimdall-pipeline/choice-types'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { deriveWatcherNotificationTransitions } from './notification'

function detail(
  entries: LedgerEntry[],
  options: {
    contact?: 'live' | 'unverifiable'
    state?: 'watching' | 'terminal'
    reason?: string
    kind?: 'hosted-review' | 'objective' | 'pipeline'
    kindPayload?: unknown
  } = {}
): WatcherDetail {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial detail double omits fields unrelated to transition routing and includes the enrollment kind/payload used for copy.
  return {
    watcher: {
      target: { watcherId: 'watcher-1', connectionId: 'runtime-1', pairingRevision: 1 },
      contact: options.contact ?? 'live',
      observedAtMs: 10,
      entry: {
        enrollment: {
          watcherId: 'watcher-1',
          kind: options.kind ?? 'objective',
          repoId: 'repo-1',
          worktreeId: 'worktree-1',
          workspacePath: '/workspace',
          terminalAtMs: options.state === 'terminal' ? 10 : null,
          kindPayload: options.kindPayload ?? {}
        },
        status: {
          state: options.state ?? 'watching',
          reason: options.reason ?? null
        }
      }
    },
    ledger: { watcherId: 'watcher-1', entries },
    traces: [],
    workers: []
  } as unknown as WatcherDetail
}

const approval: LedgerEntry = {
  eventId: 'approval-request',
  watcherId: 'watcher-1',
  atMs: 9,
  origin: 'owner',
  class: 'fact',
  kind: 'escalation',
  escalationId: 'approval-1',
  escalationKind: 'awaiting-approval',
  status: 'open',
  foldCount: 1,
  approvalScope: {
    actionKind: 'merge',
    contentIdentity: 'head-1',
    evidenceKey: 'checks-1'
  }
}

const pipelinePayload = PipelineEnrollmentPayloadSchema.parse({
  schemaVersion: 1,
  pin: {
    ref: 'repo:bugfix',
    scope: 'repo',
    id: 'bugfix',
    contentHash: `sha256:${'0'.repeat(64)}`,
    documentVersion: 1
  },
  document: {
    version: 1,
    id: 'bugfix',
    name: 'Bugfix (fast)',
    nodes: [{ id: 'approve', type: 'gate', label: 'Approve plan' }]
  },
  sourceText: '',
  runInputs: { task: 'Fix the issue' },
  workspaceKind: 'git'
})

const pipelineApproval: LedgerEntry = {
  eventId: 'pipeline-approval-request',
  watcherId: 'watcher-1',
  atMs: 9,
  origin: 'owner',
  class: 'fact',
  kind: 'escalation',
  escalationId: 'pipeline-approval-1',
  escalationKind: 'awaiting-approval',
  status: 'open',
  foldCount: 1,
  approvalScope: {
    actionKind: 'pipeline-pass-gate',
    contentIdentity: 'pipeline:hash',
    evidenceKey: makePipelineNodeEvidenceKey({
      instanceId: 'approve',
      epoch: 0,
      attempt: 0,
      cause: 'gate'
    })
  }
}

const terminal: LedgerEntry = {
  eventId: 'terminal-1',
  watcherId: 'watcher-1',
  atMs: 10,
  origin: 'owner',
  class: 'fact',
  kind: 'terminal',
  state: 'merged',
  reason: 'completed'
}

describe('Heimdall notification transitions', () => {
  it('derives only new live approval and terminal transitions', () => {
    const previous = detail([])
    const next = detail([approval, terminal], { state: 'terminal' })

    expect(deriveWatcherNotificationTransitions(previous, next, 'live')).toMatchObject([
      {
        title: 'Watcher approval requested',
        body: 'merge is waiting for approval',
        notificationId: 'approval:approval-request'
      },
      {
        title: 'Watcher reached a terminal state',
        body: 'merged: completed',
        notificationId: 'terminal:terminal-1'
      }
    ])
    expect(deriveWatcherNotificationTransitions(next, next, 'live')).toEqual([])
  })

  it('suppresses seed, replay, and contact-loss publications', () => {
    const previous = detail([])
    const next = detail([approval, terminal], { state: 'terminal' })

    expect(deriveWatcherNotificationTransitions(null, next, 'seed')).toEqual([])
    expect(deriveWatcherNotificationTransitions(previous, next, 'replay')).toEqual([])
    expect(
      deriveWatcherNotificationTransitions(
        previous,
        detail([approval], { contact: 'unverifiable' }),
        'live'
      )
    ).toEqual([])
  })
  it('uses pipeline-specific copy for remote gate approval transitions', () => {
    const previous = detail([], { kind: 'pipeline', kindPayload: pipelinePayload })
    const next = detail([pipelineApproval], { kind: 'pipeline', kindPayload: pipelinePayload })

    expect(deriveWatcherNotificationTransitions(previous, next, 'live')).toMatchObject([
      {
        title: 'Bugfix (fast) is waiting at Approve plan',
        body: 'Approve, send back or abort in Heimdall.',
        notificationId: 'approval:pipeline-approval-request'
      }
    ])
  })
})
