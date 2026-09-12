import {
  SITTER_FULL_RESYNC_MS,
  SITTER_RAPID_POLL_MS,
  areCurrentHeadRequiredChecksGreen,
  computeDesiredAction,
  deriveActionApprovalDiscrepancy,
  deriveHostedReviewSitterPacing,
  deriveHostedReviewSitterStatus,
  gateDesiredAction,
  getInFlightActions,
  getRemainingBudgetMs,
  hostedReviewSitterErrorBackoffMs,
  type HostedReviewSitterContention,
  type HostedReviewSnapshot
} from '../../shared/fork-hosted-review-sitter'
import {
  actionOwnsSitterAgent,
  type HostedReviewSitterActionExecutor
} from './service-action-executor'
import type { HostedReviewSitterLedgerLifecycle, HostedReviewSitterRunner } from './service-ledger'

function isMergeReadyCachedCandidate(review: HostedReviewSnapshot): boolean {
  return (
    review.freshness === 'cached' &&
    review.lifecycle === 'open' &&
    !review.draft &&
    review.providerReadiness.verdict === 'ready' &&
    review.providerReadiness.blockers.length === 0 &&
    review.conflicts === 'none' &&
    !review.behindBase &&
    review.queue.membership === 'not-enqueued' &&
    areCurrentHeadRequiredChecksGreen(review)
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class HostedReviewSitterRunnerLoop {
  constructor(
    private readonly actionExecutor: HostedReviewSitterActionExecutor,
    private readonly ledgerLifecycle: HostedReviewSitterLedgerLifecycle,
    private readonly isCurrent: (runner: HostedReviewSitterRunner) => boolean,
    private readonly isSuspended: () => boolean
  ) {}

  runSerialized<T>(runner: HostedReviewSitterRunner, operation: () => Promise<T>): Promise<T> {
    const result = runner.operationTail.then(operation)
    runner.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  schedule(runner: HostedReviewSitterRunner, delayMs: number): void {
    if (!this.isCurrent(runner) || this.isSuspended()) {
      return
    }
    if (runner.timer) {
      clearTimeout(runner.timer)
    }
    runner.timer = setTimeout(
      () => {
        runner.timer = null
        if (!this.isCurrent(runner) || this.isSuspended()) {
          return
        }
        if (runner.tickQueued) {
          runner.reconcileAgain = true
          return
        }
        runner.tickQueued = true
        void this.runSerialized(runner, () => this.reconcile(runner))
          .catch((error) => {
            console.warn('[hosted-review-sitter] reconcile failed:', error)
          })
          .finally(() => {
            runner.tickQueued = false
            if (runner.reconcileAgain) {
              runner.reconcileAgain = false
              this.schedule(runner, 0)
            }
          })
      },
      Math.max(0, delayMs)
    )
  }

  private async reconcile(runner: HostedReviewSitterRunner): Promise<void> {
    if (!this.isCurrent(runner) || this.isSuspended()) {
      return
    }
    this.ledgerLifecycle.checkpointActiveTime(runner, 'tick', this.isSuspended())
    try {
      await this.actionExecutor.recoverInterruptedActions(runner)
      if (!this.isCurrent(runner) || this.isSuspended()) {
        return
      }
      const inFlightActions = getInFlightActions(runner.ledger)
      if (
        inFlightActions.length === 0 &&
        getRemainingBudgetMs(runner.ledger, runner.definition.activeBudgetMs) <= 0
      ) {
        runner.activeCheckpointAtMs = null
        runner.status = this.ledgerLifecycle.budgetExhaustedStatus(runner)
        return
      }

      const fullResyncDue =
        runner.lastFullResyncAtMs === null ||
        Date.now() - runner.lastFullResyncAtMs >= SITTER_FULL_RESYNC_MS
      let snapshot = await this.actionExecutor.readSnapshotDefinition(
        runner.definition,
        fullResyncDue
      )
      if (!this.isCurrent(runner) || this.isSuspended()) {
        return
      }
      if (snapshot.freshness === 'live') {
        runner.lastFullResyncAtMs = Date.now()
      }
      if (isMergeReadyCachedCandidate(snapshot)) {
        snapshot = await this.actionExecutor.readSnapshotDefinition(runner.definition, true)
        if (!this.isCurrent(runner) || this.isSuspended()) {
          return
        }
        runner.lastFullResyncAtMs = Date.now()
      }
      runner.snapshot = snapshot

      let desiredAction = computeDesiredAction(snapshot, runner.definition, runner.ledger)
      const ownedPreparation = inFlightActions.find(
        (entry) =>
          entry.action.kind === 'prepare-fix' || entry.action.kind === 'prepare-conflict-resolution'
      )
      const ownActionId = ownedPreparation
        ? actionOwnsSitterAgent(ownedPreparation.action, ownedPreparation.actionId)
        : undefined
      const contention: HostedReviewSitterContention =
        desiredAction || inFlightActions.length > 0
          ? await this.actionExecutor.contention(runner.definition, ownActionId)
          : { state: 'clear' }
      if (!this.isCurrent(runner) || this.isSuspended()) {
        return
      }
      this.syncStatusDiscrepancies(runner, snapshot, contention)
      desiredAction = computeDesiredAction(snapshot, runner.definition, runner.ledger)
      this.ledgerLifecycle.resolveStaleApprovalDiscrepancies(runner, desiredAction)

      if (snapshot.lifecycle !== 'open') {
        this.ledgerLifecycle.recordTerminalLifecycle(runner, snapshot)
        runner.status = deriveHostedReviewSitterStatus(
          snapshot,
          runner.definition,
          runner.ledger,
          contention
        )
        runner.activeCheckpointAtMs = null
        return
      }

      if (desiredAction) {
        const gate = gateDesiredAction(
          desiredAction,
          snapshot,
          runner.definition,
          runner.ledger,
          contention
        )
        if (gate.verdict === 'allow') {
          await this.actionExecutor.executeAction(runner, snapshot, desiredAction)
          runner.consecutiveErrors = 0
          if (
            this.isCurrent(runner) &&
            getRemainingBudgetMs(runner.ledger, runner.definition.activeBudgetMs) > 0
          ) {
            this.schedule(runner, SITTER_RAPID_POLL_MS)
          } else {
            runner.activeCheckpointAtMs = null
          }
          return
        }
        if (gate.verdict === 'hold' && gate.reason === 'awaiting-approval') {
          this.ledgerLifecycle.appendDiscrepancyIfChanged(
            runner,
            deriveActionApprovalDiscrepancy(desiredAction, runner.ledger),
            true
          )
        }
      }

      runner.consecutiveErrors = 0
      runner.status = deriveHostedReviewSitterStatus(
        snapshot,
        runner.definition,
        runner.ledger,
        contention
      )
      const pacing = deriveHostedReviewSitterPacing(snapshot, runner.ledger, {
        consecutiveErrors: 0,
        lastFullResyncAtMs: runner.lastFullResyncAtMs,
        evaluatedAtMs: Date.now()
      })
      if (pacing.delayMs !== null) {
        const untilFullResync = pacing.nextFullResyncInMs ?? pacing.delayMs
        this.schedule(runner, Math.min(pacing.delayMs, untilFullResync))
      } else {
        runner.activeCheckpointAtMs = null
      }
    } catch (error) {
      if (!this.isCurrent(runner)) {
        return
      }
      runner.consecutiveErrors += 1
      runner.status = this.ledgerLifecycle.errorStatus(runner, errorMessage(error))
      const backoff =
        hostedReviewSitterErrorBackoffMs(runner.consecutiveErrors) ?? SITTER_RAPID_POLL_MS
      if (getRemainingBudgetMs(runner.ledger, runner.definition.activeBudgetMs) <= 0) {
        runner.activeCheckpointAtMs = null
      } else {
        this.schedule(runner, backoff)
      }
    }
  }

  private syncStatusDiscrepancies(
    runner: HostedReviewSitterRunner,
    snapshot: HostedReviewSnapshot,
    contention: HostedReviewSitterContention
  ): void {
    const status = deriveHostedReviewSitterStatus(
      snapshot,
      runner.definition,
      runner.ledger,
      contention
    )
    for (const discrepancy of status.discrepancies) {
      this.ledgerLifecycle.appendDiscrepancyIfChanged(runner, discrepancy, true)
    }
    runner.status = deriveHostedReviewSitterStatus(
      snapshot,
      runner.definition,
      runner.ledger,
      contention
    )
  }
}
