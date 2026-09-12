import { randomUUID } from 'node:crypto'
import {
  computeDesiredAction,
  deriveActionApprovalDiscrepancy,
  deriveHostedReviewSitterStatus,
  gateDesiredAction,
  getInFlightActions,
  type ActionLedgerEntry,
  type HostedReviewSitterAction,
  type HostedReviewSitterActionEffect,
  type HostedReviewSitterActionResult,
  type HostedReviewSitterContention,
  type HostedReviewSitterDefinition,
  type HostedReviewSnapshot
} from '../../shared/fork-hosted-review-sitter'
import type { HostedReviewSitterAgentActuator } from './agent'
import type { HostedReviewSitterProviderAdapter } from './provider'
import type { HostedReviewSitterLedgerLifecycle, HostedReviewSitterRunner } from './service-ledger'

export function actionOwnsSitterAgent(
  action: HostedReviewSitterAction,
  actionId?: string
): string | undefined {
  if (action.kind === 'publish-fix' || action.kind === 'publish-conflict-resolution') {
    return action.preparationActionId
  }
  if (action.kind === 'prepare-fix' || action.kind === 'prepare-conflict-resolution') {
    return actionId
  }
  return undefined
}

function isProviderAction(action: HostedReviewSitterAction): boolean {
  return (
    action.kind === 'rerun-check' ||
    action.kind === 'update-branch' ||
    action.kind === 'merge' ||
    action.kind === 'enqueue'
  )
}

function actionErrorEffect(error: unknown): HostedReviewSitterActionEffect {
  if (
    typeof error === 'object' &&
    error !== null &&
    'effect' in error &&
    (error.effect === 'none' || error.effect === 'committed' || error.effect === 'unknown')
  ) {
    return error.effect
  }
  return 'unknown'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Notify = (
  definition: HostedReviewSitterDefinition,
  title: string,
  body: string,
  notificationId: string
) => void

export class HostedReviewSitterActionExecutor {
  constructor(
    private readonly provider: HostedReviewSitterProviderAdapter,
    private readonly actuator: HostedReviewSitterAgentActuator,
    private readonly ledgerLifecycle: HostedReviewSitterLedgerLifecycle,
    private readonly isCurrent: (runner: HostedReviewSitterRunner) => boolean,
    private readonly isSuspended: () => boolean,
    private readonly isStopped: () => boolean,
    private readonly notify: Notify
  ) {}

  contention(
    definition: HostedReviewSitterDefinition,
    ownActionId?: string
  ): Promise<HostedReviewSitterContention> {
    return this.actuator.contention(definition, ownActionId)
  }

  async readSnapshotDefinition(
    definition: HostedReviewSitterDefinition,
    fresh: boolean
  ): Promise<HostedReviewSnapshot> {
    const snapshot = await this.provider.read(definition, { fresh })
    if (fresh && snapshot.freshness !== 'live') {
      throw new Error('Hosted review provider did not return a live snapshot')
    }
    if (
      snapshot.provider !== definition.provider ||
      snapshot.reviewNumber !== definition.reviewNumber ||
      snapshot.url !== definition.reviewUrl
    ) {
      throw new Error('Hosted review provider identity changed')
    }
    return snapshot
  }

  async recoverInterruptedActions(runner: HostedReviewSitterRunner): Promise<void> {
    for (const interrupted of getInFlightActions(runner.ledger)) {
      if (!this.isCurrent(runner)) {
        return
      }
      if (
        interrupted.action.kind === 'prepare-fix' ||
        interrupted.action.kind === 'prepare-conflict-resolution'
      ) {
        const recovery = await this.actuator.recover(runner.definition, interrupted)
        if (!this.isCurrent(runner) || recovery.state === 'running') {
          continue
        }
        if (recovery.state === 'completed') {
          this.completeRecoveredAction(runner, interrupted, recovery.result)
          continue
        }
        this.failRecoveredAction(runner, interrupted, recovery.reason)
        continue
      }
      await this.recoverProviderAction(runner, interrupted)
    }
  }

  async executeAction(
    runner: HostedReviewSitterRunner,
    observedSnapshot: HostedReviewSnapshot,
    observedAction: HostedReviewSitterAction
  ): Promise<void> {
    let snapshot = observedSnapshot
    let action = observedAction
    if (
      action.kind === 'publish-fix' ||
      action.kind === 'publish-conflict-resolution' ||
      action.kind === 'merge' ||
      action.kind === 'enqueue'
    ) {
      snapshot = await this.readSnapshotDefinition(runner.definition, true)
      if (!this.isCurrent(runner) || this.isSuspended()) {
        return
      }
      runner.snapshot = snapshot
      runner.lastFullResyncAtMs = Date.now()
      const recomputed = computeDesiredAction(snapshot, runner.definition, runner.ledger)
      if (
        !recomputed ||
        recomputed.kind !== action.kind ||
        recomputed.key !== action.key ||
        recomputed.headSha !== action.headSha
      ) {
        return
      }
      action = recomputed
    }

    const actionId = randomUUID()
    const ownActionId = actionOwnsSitterAgent(action, actionId)
    const contention = await this.actuator.contention(runner.definition, ownActionId)
    if (!this.isCurrent(runner) || this.isSuspended()) {
      return
    }
    const gate = gateDesiredAction(action, snapshot, runner.definition, runner.ledger, contention)
    if (gate.verdict !== 'allow') {
      if (gate.verdict === 'hold' && gate.reason === 'awaiting-approval') {
        this.ledgerLifecycle.appendDiscrepancyIfChanged(
          runner,
          deriveActionApprovalDiscrepancy(action, runner.ledger),
          true
        )
      }
      runner.status = deriveHostedReviewSitterStatus(
        snapshot,
        runner.definition,
        runner.ledger,
        contention
      )
      return
    }

    const attempted: ActionLedgerEntry = {
      kind: 'action',
      eventId: randomUUID(),
      actionId,
      atMs: Date.now(),
      action,
      state: 'attempted'
    }
    this.ledgerLifecycle.append(runner, attempted)
    this.ledgerLifecycle.append(runner, {
      ...attempted,
      eventId: randomUUID(),
      atMs: Date.now(),
      state: 'running'
    })
    runner.status = deriveHostedReviewSitterStatus(
      snapshot,
      runner.definition,
      runner.ledger,
      contention
    )

    const controller = new AbortController()
    runner.actionController = controller
    try {
      const result = isProviderAction(action)
        ? await this.provider.execute(runner.definition, action, controller.signal)
        : await this.actuator.execute(runner.definition, action, {
            actionId,
            signal: controller.signal
          })
      const completed: ActionLedgerEntry = {
        ...attempted,
        eventId: randomUUID(),
        atMs: Date.now(),
        state: 'completed',
        result
      }
      const wasCurrent = this.isCurrent(runner)
      if (!this.ledgerLifecycle.appendOutcome(runner, completed, this.isStopped())) {
        return
      }
      if (action.kind === 'publish-fix' && result.kind === 'published') {
        this.ledgerLifecycle.appendOutcome(
          runner,
          {
            kind: 'fix-attribution',
            eventId: randomUUID(),
            atMs: Date.now(),
            sourceHeadSha: action.headSha,
            producedHeadSha: result.resultingHeadSha,
            preparedCommitSha: action.preparedCommitSha,
            checkKey: action.checkKey,
            failureSignature: action.failureSignature,
            publishActionId: actionId
          },
          this.isStopped()
        )
      }
      if (!wasCurrent) {
        this.notify(
          runner.definition,
          'PR Sitter action completed after stop',
          `${action.kind} completed; no further sitter actions will run.`,
          completed.eventId
        )
      }
    } catch (error) {
      const effect = actionErrorEffect(error)
      const failed: ActionLedgerEntry = {
        ...attempted,
        eventId: randomUUID(),
        atMs: Date.now(),
        state: 'failed',
        effect,
        reason: errorMessage(error)
      }
      const wasCurrent = this.isCurrent(runner)
      if (!this.ledgerLifecycle.appendOutcome(runner, failed, this.isStopped())) {
        return
      }
      if (effect === 'unknown') {
        this.ledgerLifecycle.recordAmbiguousAction(runner, failed, {
          allowRetired: !wasCurrent,
          serviceStopped: this.isStopped()
        })
      } else if (effect === 'none') {
        throw error
      } else {
        this.notify(
          runner.definition,
          'PR Sitter action failed',
          `${action.kind} failed: ${failed.reason ?? 'unknown error'}`,
          failed.eventId
        )
      }
    } finally {
      if (runner.actionController === controller) {
        runner.actionController = null
      }
    }
  }

  private async recoverProviderAction(
    runner: HostedReviewSitterRunner,
    interrupted: ActionLedgerEntry
  ): Promise<void> {
    const snapshot = await this.readSnapshotDefinition(runner.definition, true)
    if (!this.isCurrent(runner)) {
      return
    }
    runner.snapshot = snapshot
    runner.lastFullResyncAtMs = Date.now()
    const result = this.recoveredProviderResult(interrupted.action, snapshot)
    if (result) {
      this.completeRecoveredAction(runner, interrupted, result)
      return
    }
    this.failRecoveredAction(
      runner,
      interrupted,
      'process-ended-before-action-outcome-could-be-verified'
    )
  }

  private recoveredProviderResult(
    action: HostedReviewSitterAction,
    snapshot: HostedReviewSnapshot
  ): HostedReviewSitterActionResult | null {
    switch (action.kind) {
      case 'rerun-check': {
        const oldObservations = new Set(action.observationIds)
        const observedRerun = snapshot.checks.some(
          (check) =>
            check.headSha === action.headSha &&
            check.checkKey === action.checkKey &&
            !oldObservations.has(check.observationId)
        )
        return observedRerun ? { kind: 'rerun-requested' } : null
      }
      case 'publish-fix':
      case 'publish-conflict-resolution':
        return snapshot.headSha === action.preparedCommitSha
          ? { kind: 'published', resultingHeadSha: snapshot.headSha }
          : null
      case 'update-branch':
        return null
      case 'merge':
        return snapshot.lifecycle === 'merged' ? { kind: 'none' } : null
      case 'enqueue':
        return snapshot.queue.membership === 'enqueued' ? { kind: 'none' } : null
      case 'prepare-fix':
      case 'prepare-conflict-resolution':
        return null
    }
  }

  private completeRecoveredAction(
    runner: HostedReviewSitterRunner,
    interrupted: ActionLedgerEntry,
    result: HostedReviewSitterActionResult
  ): void {
    this.ledgerLifecycle.append(runner, {
      ...interrupted,
      eventId: randomUUID(),
      atMs: Date.now(),
      state: 'completed',
      result,
      reason: 'recovered-after-process-restart'
    })
    if (interrupted.action.kind === 'publish-fix' && result.kind === 'published') {
      this.ledgerLifecycle.append(runner, {
        kind: 'fix-attribution',
        eventId: randomUUID(),
        atMs: Date.now(),
        sourceHeadSha: interrupted.action.headSha,
        producedHeadSha: result.resultingHeadSha,
        preparedCommitSha: interrupted.action.preparedCommitSha,
        checkKey: interrupted.action.checkKey,
        failureSignature: interrupted.action.failureSignature,
        publishActionId: interrupted.actionId
      })
    }
  }

  private failRecoveredAction(
    runner: HostedReviewSitterRunner,
    interrupted: ActionLedgerEntry,
    reason: string
  ): void {
    const failed: ActionLedgerEntry = {
      ...interrupted,
      eventId: randomUUID(),
      atMs: Date.now(),
      state: 'failed',
      effect: 'unknown',
      reason
    }
    this.ledgerLifecycle.append(runner, failed)
    this.ledgerLifecycle.recordAmbiguousAction(runner, failed)
  }
}
