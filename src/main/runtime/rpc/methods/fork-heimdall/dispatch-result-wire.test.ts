import { describe, expect, it } from 'vitest'
import {
  HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY
} from '../../../../../shared/fork-heimdall/capability'
import type { LedgerEntry, WatcherLedger } from '../../../../../shared/fork-heimdall/ledger-types'
import { projectHeimdallLedgerForClient } from './dispatch-result-wire'

function preDispatchFailureEntry(): LedgerEntry {
  return {
    eventId: 'attempt-1',
    watcherId: 'watcher-1',
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint: 'fingerprint-1',
    action: {
      kind: 'dispatch-node',
      capability: 'write',
      visibility: 'local',
      contentIdentity: 'revision-1',
      evidenceKey: 'evidence-1'
    },
    state: 'settled',
    result: { status: 'refused', reason: 'pre-dispatch-failure' }
  }
}

function escalationWithReplyEntry(): LedgerEntry {
  return {
    eventId: 'escalation-1',
    watcherId: 'watcher-1',
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: 'owner-deviation:watcher-1:worker-question:message-1',
    escalationKind: 'owner-deviation',
    status: 'open',
    foldCount: 1,
    humanReply: { body: 'Use main.', atMs: 5 }
  }
}

function ledger(entries: LedgerEntry[]): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

describe('projectHeimdallLedgerForClient', () => {
  it('leaves the ledger untouched for the local owner client', () => {
    const source = ledger([preDispatchFailureEntry(), escalationWithReplyEntry()])
    const projected = projectHeimdallLedgerForClient(source, {})
    expect(projected).toBe(source)
  })

  it('strips humanReply from a remote reader that has not negotiated answer-escalation', () => {
    const source = ledger([escalationWithReplyEntry()])
    const projected = projectHeimdallLedgerForClient(source, {
      clientKind: 'runtime',
      clientCapabilities: []
    })
    expect(projected.entries[0]).not.toHaveProperty('humanReply')
  })

  it('keeps humanReply for a remote reader that negotiated answer-escalation', () => {
    const source = ledger([escalationWithReplyEntry()])
    const projected = projectHeimdallLedgerForClient(source, {
      clientKind: 'runtime',
      clientCapabilities: [HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY]
    })
    expect(projected).toBe(source)
    expect(projected.entries[0]).toMatchObject({ humanReply: { body: 'Use main.', atMs: 5 } })
  })

  it('strips both the pre-dispatch-failure result and humanReply independently, by their own capability', () => {
    const source = ledger([preDispatchFailureEntry(), escalationWithReplyEntry()])
    const projected = projectHeimdallLedgerForClient(source, {
      clientKind: 'runtime',
      clientCapabilities: [HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY]
    })
    expect(projected.entries[0]).not.toHaveProperty('result')
    expect(projected.entries[1]).toMatchObject({ humanReply: { body: 'Use main.', atMs: 5 } })

    const otherProjection = projectHeimdallLedgerForClient(source, {
      clientKind: 'runtime',
      clientCapabilities: [HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY]
    })
    expect(otherProjection.entries[0]).toMatchObject({
      result: { status: 'refused', reason: 'pre-dispatch-failure' }
    })
    expect(otherProjection.entries[1]).not.toHaveProperty('humanReply')
  })
})
