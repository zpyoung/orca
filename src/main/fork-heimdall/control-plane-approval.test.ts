import { describe, expect, it, vi } from 'vitest'
import { approvalScopeForAction } from '../../shared/fork-heimdall/gate'
import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { EscalationEntry } from '../../shared/fork-heimdall/ledger-types'
import { action, enrollmentInput, harness, kind } from './kernel-service-test-harness'

vi.mock('electron', () => ({}))

describe('Heimdall approval control', () => {
  it('appends resolved revisions only for exact matching approval escalations and permits the action', async () => {
    const approvedAction = {
      ...action('revision-1'),
      preparedCommitSha: 'prepared-1'
    }
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const { service, ledgerStore } = await harness()
    service.registerKind(
      kind({
        decide: () => ({ action: approvedAction }),
        execute
      })
    )
    const enrolled = await service.enroll({
      ...enrollmentInput(),
      capabilities: { write: 'gated' }
    })
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    await service.reconcileForTesting(watcherId)

    const scope = approvalScopeForAction(approvedAction)
    const originalOpen = getLatestEscalations(service.ledger(watcherId)).find(
      (entry) => entry.escalationKind === 'awaiting-approval'
    )
    if (!originalOpen) {
      throw new Error('expected an awaiting-approval escalation')
    }
    const appendEscalation = (
      entry: Omit<EscalationEntry, 'watcherId' | 'origin' | 'class' | 'kind'>
    ) =>
      ledgerStore.append({
        watcherId,
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        ...entry
      })
    appendEscalation({
      eventId: 'matching-escalated',
      atMs: 20,
      escalationId: 'matching-escalated',
      escalationKind: 'awaiting-approval',
      status: 'escalated',
      foldCount: 4,
      approvalScope: scope
    })
    appendEscalation({
      eventId: 'newer-prepared-commit',
      atMs: 21,
      escalationId: 'newer-prepared-commit',
      escalationKind: 'awaiting-approval',
      status: 'open',
      foldCount: 2,
      approvalScope: { ...scope, preparedCommitSha: 'prepared-2' }
    })
    appendEscalation({
      eventId: 'other-kind',
      atMs: 22,
      escalationId: 'other-kind',
      escalationKind: 'worker-question',
      status: 'open',
      foldCount: 3,
      approvalScope: scope
    })

    const before = service.ledger(watcherId)
    const row = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: { kind: 'approve', scope }
      })
    ).resolves.toMatchObject({ status: 'applied' })

    const after = service.ledger(watcherId)
    expect(after.entries).toHaveLength(before.entries.length + 3)
    expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries)
    expect(after.entries.slice(before.entries.length)).toEqual([
      expect.objectContaining({ kind: 'approval', scope, decision: 'approved' }),
      expect.objectContaining({
        kind: 'escalation',
        escalationId: originalOpen.escalationId,
        status: 'resolved',
        foldCount: originalOpen.foldCount + 1,
        approvalScope: scope
      }),
      expect.objectContaining({
        kind: 'escalation',
        escalationId: 'matching-escalated',
        status: 'resolved',
        foldCount: 5,
        approvalScope: scope
      })
    ])
    const latest = getLatestEscalations(after)
    expect(latest.find((entry) => entry.escalationId === 'newer-prepared-commit')).toMatchObject({
      status: 'open',
      foldCount: 2
    })
    expect(latest.find((entry) => entry.escalationId === 'other-kind')).toMatchObject({
      status: 'open',
      foldCount: 3
    })

    await service.reconcileForTesting(watcherId)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
