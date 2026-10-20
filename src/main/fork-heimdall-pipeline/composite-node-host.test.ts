import { describe, expect, it, vi } from 'vitest'
import type {
  DecisionOutcome,
  ExecuteContext,
  KernelAction,
  LeaseGuard,
  OwnerAdapter,
  PreflightContext,
  StopPredicate,
  SubmissionAdapter,
  WatcherKind
} from '../../shared/fork-heimdall/kind-contract'
import { gateAction, approvalScopeForAction } from '../../shared/fork-heimdall/gate'
import type {
  ApprovalEntry,
  AttemptEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { InterventionSchema } from '../../shared/fork-heimdall/owner/intervention'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  CompositeNodeConfigurationError,
  CompositeScopeError,
  createCompositeNodeHost
} from './composite-node-host'
import { wrapCompositeAction } from '../../shared/fork-heimdall-pipeline/interpreter/ledger-lens'
import {
  action as makeAction,
  authorized,
  enrollmentInput,
  kind,
  type World
} from '../fork-heimdall/kernel-service-test-harness'

const INSTANCE_ID = 'pr-sitter'
const EPOCH = 2
const RUN_IDENTITY = 'pipeline:graph-content-hash'

function snapshot(headSha: string): Snapshot<World> {
  return {
    freshness: 'live',
    contentIdentity: `review:${headSha}`,
    observedAtMs: 10,
    world: { revision: headSha }
  }
}

function watcherEnrollment(): WatcherEnrollment {
  return {
    ...authorized(enrollmentInput()),
    watcherId: 'watcher-1',
    enabled: true,
    paused: false,
    commandRevision: 0,
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  }
}

function reviewAction(headSha: string): KernelAction {
  return {
    ...makeAction(headSha),
    kind: 'update-branch',
    capability: 'updateBranch',
    headSha,
    reviewUrl: 'https://example.test/review/1'
  }
}
function mergeReviewAction(headSha: string): KernelAction {
  const reviewUrl = 'https://example.test/review/1'
  return {
    ...makeAction(headSha),
    kind: 'merge',
    capability: 'merge',
    headSha,
    reviewUrl,
    expectedState: { target: reviewUrl, before: headSha }
  }
}

function attempt(attemptId: string, action: KernelAction): AttemptEntry {
  return {
    eventId: `event-${attemptId}`,
    watcherId: 'watcher-1',
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId,
    fingerprint: 'outer-fingerprint',
    action,
    state: 'running'
  }
}

function ledger(entries: WatcherLedger['entries'] = []): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

function actionFromDecision(outcome: DecisionOutcome<KernelAction>): KernelAction {
  if (outcome.action === null) {
    throw new Error('Expected a composite action')
  }
  return outcome.action
}

function emptyLease(): LeaseGuard {
  return {
    epoch: 1,
    holder: 'test-holder',
    assertHeld: async () => {},
    renewLoop: () => ({ dispose: () => {} })
  }
}

describe('CompositeNodeHost identity mode', () => {
  it('preserves the exact snapshot and every runner-facing member reference', async () => {
    const current = snapshot('head-1')
    const nextSnapshot = snapshot('head-2')
    const stopPredicate = {
      id: 'terminal',
      evaluate: () => ({ stop: false as const })
    } satisfies StopPredicate<World>
    const concurrency: NonNullable<WatcherKind<World, KernelAction>['concurrency']> = {
      canRunAlongside: () => false,
      shouldDrainBudget: () => false,
      preserveAttemptOnContentChange: () => false,
      canRunWhenBudgetExhausted: () => false,
      isIsolatedAttempt: () => false,
      retainWorker: () => false
    }
    const planner: NonNullable<WatcherKind<World, KernelAction>['planner']> = {
      world: { revision: 'head-1' }
    }
    const handoff: NonNullable<WatcherKind<World, KernelAction>['handoff']> = {
      derive: async () => ({ kind: 'none', reason: 'not-ready' })
    }
    const submission: SubmissionAdapter<World> = {
      preflightWorkerReport: async () => ({ status: 'accepted' })
    }
    const owner: OwnerAdapter<World, KernelAction> = {
      describeState: () => ({ text: 'state', truncated: false }),
      describeInterventions: () => 'continue',
      interventionSchema: InterventionSchema,
      rejectIntervention: () => null,
      actionForIntervention: () => makeAction('head-1')
    }
    const debug: NonNullable<WatcherKind<World, KernelAction>['debug']> = {
      pointers: () => []
    }
    const snapshots = [current, nextSnapshot]
    const read = vi.fn(async () => {
      const next = snapshots.shift()
      if (next === undefined) {
        throw new Error('No more snapshots')
      }
      return next
    })
    const decide = vi.fn(() => ({ action: reviewAction('head-1') }))
    const preflight = vi.fn(async () => ({ verdict: 'allow' as const }))
    const attemptExpectation = vi.fn(() => ({ expectedBefore: 'before', expectedAfter: 'after' }))
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const resolveOutcome = vi.fn(() => ({ effect: 'not-landed' as const }))
    const describeApproval = vi.fn(() => null)
    const pacing = { pace: vi.fn(() => 'active' as const) }
    const inner = kind({
      id: 'objective',
      read,
      decide,
      preflight,
      attemptExpectation,
      execute,
      resolveOutcome,
      stopPredicates: [stopPredicate],
      concurrency,
      planner,
      handoff,
      submission,
      owner,
      debug,
      describeApproval,
      pacing
    })
    const host = createCompositeNodeHost(inner, { kind: 'identity' })

    await expect(host.read(watcherEnrollment(), { fresh: true })).resolves.toBe(current)
    await expect(host.read(watcherEnrollment(), { fresh: false })).resolves.toBe(nextSnapshot)
    expect(read).toHaveBeenCalledTimes(2)
    for (const member of [
      'read',
      'describeSnapshot',
      'decide',
      'preflight',
      'attemptExpectation',
      'execute',
      'resolveOutcome',
      'stopPredicates',
      'concurrency',
      'planner',
      'handoff',
      'submission',
      'owner',
      'debug',
      'describeApproval',
      'pacing'
    ] as const) {
      expect(host[member]).toBe(inner[member])
    }
  })

  it('returns unknown when a built-in phase cannot read the snapshot', () => {
    const inner = kind({
      id: 'objective',
      describeSnapshot: () => {
        throw new Error('unreadable')
      }
    })
    const host = createCompositeNodeHost(inner, { kind: 'identity' })

    expect(host.phase(snapshot('head-1'), ledger())).toBe('unknown')
  })
})

describe('CompositeNodeHost node-scoped mode', () => {
  it('refuses a node-scoped host without the outer run identity', () => {
    const missingIdentity = () =>
      createCompositeNodeHost(
        kind(),
        { kind: 'node-scoped', instanceId: INSTANCE_ID, epoch: EPOCH },
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: A missing identity exercises the runtime refusal for untyped callers.
        undefined as unknown as string
      )
    expect(missingIdentity).toThrow(CompositeNodeConfigurationError)
  })

  it('scopes the ledger and delegates stop, action, effect, phase, and pacing with inner snapshots', async () => {
    const current = snapshot('head-1')
    const fresh: LiveSnapshot<World> = { ...current, freshness: 'live' }
    const nativeAction = reviewAction('head-1')
    const decide = vi.fn((_snapshot: Snapshot<World>, _ledger: WatcherLedger) => ({
      action: nativeAction
    }))
    const preflight = vi.fn(
      async (
        _action: KernelAction,
        _snapshot: Snapshot<World>,
        _ledger: WatcherLedger,
        _context: PreflightContext
      ) => ({ verdict: 'allow' as const })
    )
    const attemptExpectation = vi.fn((_action: KernelAction, _snapshot: Snapshot<World>) => ({
      expectedBefore: 'before',
      expectedAfter: 'after'
    }))
    const execute = vi.fn(async (_action: KernelAction, _context: ExecuteContext<World>) => ({
      effect: 'landed' as const
    }))
    const resolveOutcome = vi.fn(
      (
        _attempt: AttemptEntry,
        _fresh: LiveSnapshot<World>,
        _ledger: WatcherLedger,
        _lease: LeaseGuard
      ) => ({ effect: 'landed' as const })
    )
    const evaluateStop = vi.fn((_snapshot: Snapshot<World>, _ledger: WatcherLedger) => ({
      stop: true as const,
      reason: 'review-closed',
      detail: 'The pull request is closed'
    }))
    const stopPredicate = {
      id: 'review-lifecycle',
      disposition: 'terminal',
      evaluate: evaluateStop
    } satisfies StopPredicate<World>
    const pace = vi.fn((_snapshot: Snapshot<World>, _ledger: WatcherLedger) => 'active' as const)
    const inner = kind({
      read: vi.fn(async () => current),
      decide,
      preflight,
      attemptExpectation,
      execute,
      resolveOutcome,
      stopPredicates: [stopPredicate],
      pacing: { pace }
    })
    const host = createCompositeNodeHost(
      inner,
      { kind: 'node-scoped', instanceId: INSTANCE_ID, epoch: EPOCH },
      RUN_IDENTITY
    )
    const view = watcherEnrollment()
    const options = { fresh: true }

    await expect(host.read(view, options)).resolves.toBe(current)
    expect(inner.read).toHaveBeenCalledWith(view, options)

    const outcome = host.decide(current, ledger())
    const wrappedAction = actionFromDecision(outcome)
    expect(wrappedAction.contentIdentity).toBe(RUN_IDENTITY)
    expect(wrappedAction).toMatchObject({
      kind: nativeAction.kind,
      capability: nativeAction.capability,
      pipelineNode: {
        instanceId: INSTANCE_ID,
        epoch: EPOCH,
        inner: {
          contentIdentity: nativeAction.contentIdentity,
          evidenceKey: nativeAction.evidenceKey
        }
      }
    })
    expect(decide.mock.calls[0]?.[0]).toBe(current)

    const anotherNodeAction = wrapCompositeAction(
      'agent',
      3,
      reviewAction('other-head'),
      RUN_IDENTITY
    )
    const currentAttempt = attempt('attempt-current', wrappedAction)
    const fullLedger = ledger([currentAttempt, attempt('attempt-other', anotherNodeAction)])
    const executionContext: ExecuteContext<World> = {
      snapshot: current,
      lease: emptyLease(),
      ledger: fullLedger,
      dispatchWorker: vi.fn(async () => ({ status: 'dispatched' as const, dispatchId: 'worker-1' }))
    }
    const approvalContext: PreflightContext = { enrollment: view }

    expect(await host.preflight?.(wrappedAction, current, fullLedger, approvalContext)).toEqual({
      verdict: 'allow'
    })
    expect(preflight.mock.calls[0]?.[0]).toEqual(nativeAction)
    expect(preflight.mock.calls[0]?.[1]).toBe(current)
    expect(preflight.mock.calls[0]?.[2].entries).toHaveLength(1)
    expect(preflight.mock.calls[0]?.[2].entries[0]).toMatchObject({
      attemptId: 'attempt-current',
      action: nativeAction,
      fingerprint: makeAttemptFingerprint(
        nativeAction.contentIdentity,
        nativeAction.kind,
        nativeAction.evidenceKey
      )
    })
    expect(host.attemptExpectation?.(wrappedAction, current)).toEqual({
      expectedBefore: 'before',
      expectedAfter: 'after'
    })
    expect(attemptExpectation.mock.calls[0]?.[0]).toEqual(nativeAction)
    expect(attemptExpectation.mock.calls[0]?.[1]).toBe(current)

    await host.execute(wrappedAction, executionContext)
    const execution = execute.mock.calls[0]
    expect(execution?.[0]).toEqual(nativeAction)
    expect(execution?.[1].snapshot).toBe(current)
    expect(execution?.[1].ledger.entries).toHaveLength(1)

    await host.resolveOutcome(currentAttempt, fresh, fullLedger, executionContext.lease)
    const resolution = resolveOutcome.mock.calls[0]
    expect(resolution?.[0].action).toEqual(nativeAction)
    expect(resolution?.[1]).toBe(fresh)
    expect(resolution?.[2].entries).toHaveLength(1)
    const scopedAttempt = resolution?.[2].entries.find(
      (entry): entry is AttemptEntry => entry.kind === 'attempt'
    )
    expect(scopedAttempt?.fingerprint).toBe(
      makeAttemptFingerprint(
        nativeAction.contentIdentity,
        nativeAction.kind,
        nativeAction.evidenceKey
      )
    )
    expect(resolution?.[3]).toBe(executionContext.lease)

    const fired = host.evaluateStops(current, fullLedger)
    expect(fired).toEqual({
      predicateId: 'review-lifecycle',
      disposition: 'terminal',
      reason: 'review-closed',
      detail: 'The pull request is closed'
    })
    expect(evaluateStop.mock.calls[0]?.[0]).toBe(current)
    expect(evaluateStop.mock.calls[0]?.[1].entries).toHaveLength(1)
    expect(host.pace(current, fullLedger)).toBe('active')
    expect(pace.mock.calls[0]?.[1].entries).toHaveLength(1)
    expect(host.phase(current, fullLedger)).toBe('updating-branch')
  })

  it('keeps a sitter merge approval separate from a preceding gate and refreshes it on a new PR head', () => {
    const inner = kind({
      decide: (current) => ({ action: mergeReviewAction(current.world.revision) })
    })
    const host = createCompositeNodeHost(
      inner,
      { kind: 'node-scoped', instanceId: INSTANCE_ID, epoch: EPOCH },
      RUN_IDENTITY
    )
    const oldAction = actionFromDecision(host.decide(snapshot('head-old'), ledger()))
    const nextAction = actionFromDecision(host.decide(snapshot('head-new'), ledger()))
    const gateApproval: ApprovalEntry = {
      eventId: 'approval-preceding-gate',
      watcherId: 'watcher-1',
      atMs: 10,
      origin: 'owner',
      class: 'fact',
      kind: 'approval',
      scope: {
        actionKind: 'pipeline-pass-gate',
        contentIdentity: RUN_IDENTITY,
        evidenceKey: 'preceding-gate'
      },
      decision: 'approved',
      foldCount: 1
    }
    const oldMergeApproval: ApprovalEntry = {
      eventId: 'approval-old-head',
      watcherId: 'watcher-1',
      atMs: 11,
      origin: 'owner',
      class: 'fact',
      kind: 'approval',
      scope: approvalScopeForAction(oldAction),
      decision: 'approved',
      foldCount: 1
    }
    const nextMergeApproval: ApprovalEntry = {
      eventId: 'approval-new-head',
      watcherId: 'watcher-1',
      atMs: 12,
      origin: 'owner',
      class: 'fact',
      kind: 'approval',
      scope: approvalScopeForAction(nextAction),
      decision: 'approved',
      foldCount: 1
    }
    const outerSnapshot: Snapshot<World> = {
      freshness: 'live',
      contentIdentity: RUN_IDENTITY,
      observedAtMs: 12,
      world: { revision: 'head-new' }
    }
    const enrollment = {
      enabled: true,
      capabilities: { merge: 'gated' },
      budget: { wallClockActiveMs: 10_000, turns: 10 }
    } as const

    expect(oldAction.contentIdentity).toBe(nextAction.contentIdentity)
    expect(oldAction.evidenceKey).not.toBe(nextAction.evidenceKey)
    expect(
      gateAction(nextAction, outerSnapshot, enrollment, ledger([gateApproval, oldMergeApproval]))
    ).toMatchObject({ verdict: 'hold', reason: 'awaiting-approval' })
    expect(
      gateAction(
        nextAction,
        outerSnapshot,
        enrollment,
        ledger([gateApproval, oldMergeApproval, nextMergeApproval])
      )
    ).toEqual({ verdict: 'allow' })
  })

  it('rejects actions from another node or run and marks inner read failures node-local', async () => {
    const failingRead = vi.fn(async () => {
      throw new Error('review provider unavailable')
    })
    const inner = kind({ read: failingRead })
    const host = createCompositeNodeHost(
      inner,
      { kind: 'node-scoped', instanceId: INSTANCE_ID, epoch: EPOCH },
      RUN_IDENTITY
    )
    const wrongNodeAction = wrapCompositeAction('agent', 3, reviewAction('head-1'), RUN_IDENTITY)
    const wrongRunAction = wrapCompositeAction(
      INSTANCE_ID,
      EPOCH,
      reviewAction('head-1'),
      'pipeline:other-content-hash'
    )
    const context: ExecuteContext<World> = {
      snapshot: snapshot('head-1'),
      lease: emptyLease(),
      ledger: ledger(),
      dispatchWorker: vi.fn(async () => ({ status: 'dispatched' as const, dispatchId: 'worker-1' }))
    }

    await expect(host.execute(wrongNodeAction, context)).rejects.toBeInstanceOf(CompositeScopeError)
    await expect(host.execute(wrongRunAction, context)).rejects.toBeInstanceOf(CompositeScopeError)
    const readFailure = await host
      .read(watcherEnrollment(), { fresh: true })
      .catch((cause: unknown) => cause)
    expect(readFailure).toBeInstanceOf(CompositeNodeConfigurationError)
    expect(readFailure).toMatchObject({
      instanceId: INSTANCE_ID,
      epoch: EPOCH,
      detail: 'review provider unavailable'
    })
  })
})
