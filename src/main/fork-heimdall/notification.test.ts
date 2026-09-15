import { describe, expect, it } from 'vitest'
import type { WatcherDetail } from '../../shared/fork-heimdall/fleet-types'
import type { LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import { deriveWatcherNotificationTransitions } from './notification'

function detail(
  entries: LedgerEntry[],
  options: {
    contact?: 'live' | 'unverifiable'
    state?: 'watching' | 'terminal'
    reason?: string
  } = {}
): WatcherDetail {
  return {
    watcher: {
      target: { watcherId: 'watcher-1', connectionId: 'runtime-1', pairingRevision: 1 },
      contact: options.contact ?? 'live',
      observedAtMs: 10,
      entry: {
        enrollment: {
          watcherId: 'watcher-1',
          repoId: 'repo-1',
          worktreeId: 'worktree-1',
          workspacePath: '/workspace',
          terminalAtMs: options.state === 'terminal' ? 10 : null
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
})
