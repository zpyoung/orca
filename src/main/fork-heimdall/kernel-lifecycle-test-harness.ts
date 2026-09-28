import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
export { authorized, harness, kind as watcherKind, type World } from './kernel-service-test-harness'

export const input: EnrollInput = {
  kind: 'hosted-review',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  capabilities: { write: 'on' },
  budget: { wallClockActiveMs: 100_000, turns: 10 },
  kindPayload: { label: 'Recovery' }
}

export function action(revision: string, recovery?: 'replay-safe'): KernelAction {
  return {
    kind: 'store-write',
    capability: 'write',
    visibility: 'local',
    contentIdentity: revision,
    evidenceKey: `write:${revision}`,
    ...(recovery ? { recovery } : {})
  }
}

export function attempted(watcherId: string, attemptedAction: KernelAction): AttemptEntry {
  return {
    eventId: 'attempted-event',
    watcherId,
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint: makeAttemptFingerprint(
      attemptedAction.contentIdentity,
      attemptedAction.kind,
      attemptedAction.evidenceKey
    ),
    action: attemptedAction,
    state: 'attempted'
  }
}

export function runningDispatch(watcherId: string): LedgerEntry[] {
  const writeAhead = {
    ...attempted(watcherId, action('revision-1')),
    dispatch: { spec: 'Finish the objective.', dispatchKind: 'child' as const }
  }
  return [
    writeAhead,
    {
      ...writeAhead,
      eventId: 'running-event',
      state: 'running' as const,
      dispatchId: 'dispatch-1'
    }
  ]
}
