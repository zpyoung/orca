import { z } from 'zod'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, LedgerEntry } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
export { harness } from './kernel-service-test-harness'

export type World = { revision: string }

export const input: EnrollInput = {
  kind: 'hosted-review',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  capabilities: { write: 'on' },
  budget: { wallClockActiveMs: 100_000, turns: 10 },
  kindPayload: { label: 'Recovery' }
}

export function authorized(enrollment: EnrollInput) {
  return {
    kind: enrollment.kind,
    workspaceKey: 'local::/workspace/recovery' as const,
    executionHostId: 'local' as const,
    repoId: enrollment.repoId,
    worktreeId: enrollment.worktreeId,
    workspacePath: '/workspace/recovery',
    schedulerOwner: 'local_host_service' as const,
    capabilities: enrollment.capabilities,
    budget: enrollment.budget,
    kindPayload: enrollment.kindPayload
  }
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

export function watcherKind(
  overrides: Partial<WatcherKind<World, KernelAction, { label: string }>> = {}
) {
  const snapshot: Snapshot<World> = {
    freshness: 'live',
    contentIdentity: 'revision-1',
    observedAtMs: 100,
    world: { revision: 'revision-1' }
  }
  return {
    id: 'hosted-review',
    displayName: 'Hosted review',
    describeEnrollment: () => 'Recovery',
    enrollmentPayloadSchema: z.object({ label: z.string() }).strict(),
    authorizeEnrollment: async (enrollment: EnrollInput) => authorized(enrollment),
    read: async () => snapshot,
    describeSnapshot: (value: Snapshot<World>) => ({
      freshness: value.freshness,
      contentIdentity: value.contentIdentity,
      summary: value.world.revision
    }),
    decide: () => ({ action: null, reason: 'quiet', considered: [] }),
    execute: async () => ({ effect: 'landed' as const }),
    resolveOutcome: () => ({ effect: 'not-landed' as const }),
    ...overrides
  } satisfies WatcherKind<World, KernelAction, { label: string }>
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
