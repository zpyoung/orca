import { describe, expect, it, vi } from 'vitest'
import type { AcceptedWorkerCompletionContext } from '../../shared/fork-heimdall/kind-contract'
import type {
  AttemptEntry,
  EvidenceEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { LeaseGuard } from './lease-store'
import {
  resolveAcceptedCompletionEffect,
  type AcceptedCompletionRunner
} from './runner-accepted-completion'

const watcherId = 'watcher-1'

const runningAttempt: AttemptEntry = {
  kind: 'attempt',
  eventId: 'event-attempt',
  watcherId,
  atMs: 1,
  origin: 'owner',
  class: 'fact',
  attemptId: 'attempt-1',
  fingerprint: 'fingerprint-1',
  action: {
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'local',
    contentIdentity: 'content-1',
    evidenceKey: 'evidence-key-1'
  },
  state: 'running',
  dispatchId: 'dispatch-1'
}

const evidence: EvidenceEntry = {
  kind: 'evidence',
  eventId: 'event-evidence',
  watcherId,
  atMs: 2,
  origin: 'owner',
  class: 'fact',
  evidenceKind: 'worker-report',
  payload: { ok: true }
}

const ledger: WatcherLedger = { watcherId, entries: [runningAttempt, evidence] }
const ledgerStore = { read: () => ledger }
const input = { dispatchId: 'dispatch-1', outcome: 'succeeded', result: { ok: true }, evidence }

function lease(): LeaseGuard {
  return {
    epoch: 1,
    holder: 'host',
    assertHeld: vi.fn(async () => {}),
    renewLoop: () => ({ dispose: () => {} })
  }
}

function runner(
  resolveAcceptedWorkerCompletion?: (
    completion: AcceptedWorkerCompletionContext
  ) => ReturnType<NonNullable<AcceptedCompletionRunner['kind']['resolveAcceptedWorkerCompletion']>>,
  leaseGuard: LeaseGuard | null = lease()
): AcceptedCompletionRunner {
  return {
    enrollment: { watcherId },
    kind: resolveAcceptedWorkerCompletion ? { resolveAcceptedWorkerCompletion } : {},
    leaseGuard
  }
}

describe('resolveAcceptedCompletionEffect', () => {
  it('leaves a failed worker indeterminate without asking the kind', async () => {
    const hook = vi.fn(async () => ({ effect: 'landed' as const }))
    await expect(
      resolveAcceptedCompletionEffect(runner(hook), ledgerStore, { ...input, outcome: 'failed' })
    ).resolves.toBe('indeterminate')
    expect(hook).not.toHaveBeenCalled()
  })

  it('lands a succeeded worker for kinds without completion resolution', async () => {
    await expect(resolveAcceptedCompletionEffect(runner(), ledgerStore, input)).resolves.toBe(
      'landed'
    )
  })

  it('passes the running attempt, evidence, ledger and lease to the kind', async () => {
    const guard = lease()
    const hook = vi.fn(async () => ({ effect: 'landed' as const }))
    await expect(
      resolveAcceptedCompletionEffect(runner(hook, guard), ledgerStore, input)
    ).resolves.toBe('landed')
    expect(hook).toHaveBeenCalledWith({
      attempt: runningAttempt,
      dispatchId: 'dispatch-1',
      evidence,
      ledger,
      lease: guard,
      result: { ok: true }
    })
    expect(guard.assertHeld).toHaveBeenCalledTimes(2)
  })

  it('lands when the kind declines ownership with null', async () => {
    const hook = vi.fn(async () => null)
    await expect(resolveAcceptedCompletionEffect(runner(hook), ledgerStore, input)).resolves.toBe(
      'landed'
    )
  })

  it('stays indeterminate when the kind cannot confirm the completion', async () => {
    const hook = vi.fn(async () => ({ effect: 'indeterminate' as const }))
    await expect(resolveAcceptedCompletionEffect(runner(hook), ledgerStore, input)).resolves.toBe(
      'indeterminate'
    )
  })

  it('stays indeterminate when the kind throws', async () => {
    const hook = vi.fn(async () => {
      throw new Error('verification failed')
    })
    await expect(resolveAcceptedCompletionEffect(runner(hook), ledgerStore, input)).resolves.toBe(
      'indeterminate'
    )
  })

  it('lands without asking the kind when no running attempt matches the dispatch', async () => {
    const hook = vi.fn(async () => ({ effect: 'indeterminate' as const }))
    await expect(
      resolveAcceptedCompletionEffect(runner(hook), ledgerStore, {
        ...input,
        dispatchId: 'dispatch-other'
      })
    ).resolves.toBe('landed')
    expect(hook).not.toHaveBeenCalled()
  })

  it('refuses kind resolution without a held lease', async () => {
    const hook = vi.fn(async () => ({ effect: 'landed' as const }))
    await expect(
      resolveAcceptedCompletionEffect(runner(hook, null), ledgerStore, input)
    ).rejects.toThrow('without a lease')
    expect(hook).not.toHaveBeenCalled()
  })

  it('propagates lease loss after the kind resolves', async () => {
    const guard = lease()
    vi.mocked(guard.assertHeld)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('lease lost'))
    const hook = vi.fn(async () => ({ effect: 'landed' as const }))
    await expect(
      resolveAcceptedCompletionEffect(runner(hook, guard), ledgerStore, input)
    ).rejects.toThrow('lease lost')
  })
})
