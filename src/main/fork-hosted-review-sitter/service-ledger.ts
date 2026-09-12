import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  approvalScopeForAction,
  getActiveTimeMs,
  getLatestDiscrepancies,
  getRemainingBudgetMs,
  hasRecordedLifecycle,
  makeEvidenceKey,
  type ActionApprovalScope,
  type ActionLedgerEntry,
  type DerivedHostedReviewSitterDiscrepancy,
  type DiscrepancyLedgerEntry,
  type HostedReviewSitterAction,
  type HostedReviewSitterDefinition,
  type HostedReviewSitterLedger,
  type HostedReviewSitterLedgerEntry,
  type HostedReviewSitterStatus,
  type HostedReviewSnapshot,
  type LifecycleLedgerEntry
} from '../../shared/fork-hosted-review-sitter'
import type { HostedReviewSitterJournalStore } from './journal-store'

const ACTIVE_TIME_CHECKPOINT_MS = 15_000
const MAX_UNOBSERVED_ACTIVE_DELTA_MS = ACTIVE_TIME_CHECKPOINT_MS * 2

export type HostedReviewSitterRunner = {
  definition: HostedReviewSitterDefinition
  ledger: HostedReviewSitterLedger
  timer: ReturnType<typeof setTimeout> | null
  operationTail: Promise<void>
  tickQueued: boolean
  reconcileAgain: boolean
  fenced: boolean
  actionController: AbortController | null
  snapshot: HostedReviewSnapshot | null
  status: HostedReviewSitterStatus | null
  consecutiveErrors: number
  lastFullResyncAtMs: number | null
  activeCheckpointAtMs: number | null
}

type Notify = (
  definition: HostedReviewSitterDefinition,
  title: string,
  body: string,
  notificationId: string
) => void

function scopesEqual(left: ActionApprovalScope, right: ActionApprovalScope): boolean {
  return (
    left.action === right.action &&
    left.headSha === right.headSha &&
    left.evidenceKey === right.evidenceKey &&
    left.preparedCommitSha === right.preparedCommitSha
  )
}

export function createHostedReviewSitterRunner(
  definition: HostedReviewSitterDefinition,
  journal: HostedReviewSitterJournalStore
): HostedReviewSitterRunner {
  return {
    definition,
    ledger: journal.read(definition.id),
    timer: null,
    operationTail: Promise.resolve(),
    tickQueued: false,
    reconcileAgain: false,
    fenced: false,
    actionController: null,
    snapshot: null,
    status: null,
    consecutiveErrors: 0,
    lastFullResyncAtMs: null,
    activeCheckpointAtMs: performance.now()
  }
}

export class HostedReviewSitterLedgerLifecycle {
  constructor(
    private readonly journal: HostedReviewSitterJournalStore,
    private readonly isCurrent: (runner: HostedReviewSitterRunner) => boolean,
    private readonly notify: Notify
  ) {}

  append(runner: HostedReviewSitterRunner, entry: HostedReviewSitterLedgerEntry): void {
    if (!this.isCurrent(runner)) {
      throw new Error('Hosted review sitter stopped before durable write')
    }
    this.appendUnchecked(runner, entry)
  }

  appendOutcome(
    runner: HostedReviewSitterRunner,
    entry: HostedReviewSitterLedgerEntry,
    serviceStopped: boolean
  ): boolean {
    if (this.isCurrent(runner)) {
      this.appendUnchecked(runner, entry)
      return true
    }
    if (serviceStopped) {
      return false
    }
    this.appendUnchecked(runner, entry)
    return true
  }

  appendDiscrepancyIfChanged(
    runner: HostedReviewSitterRunner,
    discrepancy: DerivedHostedReviewSitterDiscrepancy,
    shouldNotify: boolean,
    options: { allowRetired?: boolean; serviceStopped?: boolean } = {}
  ): void {
    const previous = getLatestDiscrepancies(runner.ledger).get(discrepancy.id)
    if (
      previous?.status === discrepancy.status &&
      previous.reason === discrepancy.reason &&
      ((previous.approvalScope === undefined && discrepancy.approvalScope === undefined) ||
        (previous.approvalScope !== undefined &&
          discrepancy.approvalScope !== undefined &&
          scopesEqual(previous.approvalScope, discrepancy.approvalScope)))
    ) {
      return
    }
    const entry: DiscrepancyLedgerEntry = {
      kind: 'discrepancy',
      eventId: randomUUID(),
      atMs: Date.now(),
      discrepancyId: discrepancy.id,
      discrepancyKind: discrepancy.kind,
      evidenceKey: discrepancy.evidenceKey,
      headSha: discrepancy.headSha,
      status: discrepancy.status,
      ...(discrepancy.approvalScope ? { approvalScope: discrepancy.approvalScope } : {}),
      reason: discrepancy.reason
    }
    const wasEverRecorded = runner.ledger.entries.some(
      (candidate) => candidate.kind === 'discrepancy' && candidate.discrepancyId === discrepancy.id
    )
    if (options.allowRetired) {
      if (!this.appendOutcome(runner, entry, options.serviceStopped ?? false)) {
        return
      }
    } else {
      this.append(runner, entry)
    }
    if (
      shouldNotify &&
      !wasEverRecorded &&
      (discrepancy.status === 'open' || discrepancy.status === 'escalated')
    ) {
      const title =
        discrepancy.kind === 'awaiting-approval'
          ? 'PR Sitter needs approval'
          : discrepancy.status === 'escalated'
            ? 'PR Sitter escalated'
            : 'PR Sitter found a discrepancy'
      this.notify(runner.definition, title, discrepancy.reason, entry.eventId)
    }
  }

  resolveStaleApprovalDiscrepancies(
    runner: HostedReviewSitterRunner,
    desiredAction: HostedReviewSitterAction | null
  ): void {
    const desiredScope = desiredAction ? approvalScopeForAction(desiredAction) : null
    for (const discrepancy of getLatestDiscrepancies(runner.ledger).values()) {
      if (
        discrepancy.discrepancyKind !== 'awaiting-approval' ||
        discrepancy.status === 'resolved' ||
        (desiredScope &&
          discrepancy.approvalScope &&
          scopesEqual(desiredScope, discrepancy.approvalScope))
      ) {
        continue
      }
      this.append(runner, {
        ...discrepancy,
        eventId: randomUUID(),
        atMs: Date.now(),
        status: 'resolved',
        reason: 'approval-evidence-no-longer-current'
      })
    }
  }

  acknowledgeRearm(runner: HostedReviewSitterRunner): void {
    for (const discrepancy of getLatestDiscrepancies(runner.ledger).values()) {
      if (
        discrepancy.status !== 'escalated' ||
        discrepancy.discrepancyKind === 'ambiguous-action' ||
        discrepancy.discrepancyKind === 'unverifiable-failure'
      ) {
        continue
      }
      this.append(runner, {
        ...discrepancy,
        eventId: randomUUID(),
        atMs: Date.now(),
        status: 'acknowledged',
        reason: 'user-rearmed-with-updated-policy'
      })
    }
  }

  recordAmbiguousAction(
    runner: HostedReviewSitterRunner,
    action: ActionLedgerEntry,
    options: { allowRetired?: boolean; serviceStopped?: boolean } = {}
  ): void {
    const evidenceKey = makeEvidenceKey([action.action.key, action.actionId])
    const discrepancy: DerivedHostedReviewSitterDiscrepancy = {
      id: makeEvidenceKey(['ambiguous-action', action.action.headSha, evidenceKey]),
      kind: 'ambiguous-action',
      evidenceKey,
      headSha: action.action.headSha,
      status: 'escalated',
      reason: `action-outcome-ambiguous:${action.action.kind}`
    }
    this.appendDiscrepancyIfChanged(runner, discrepancy, true, options)
  }

  recordTerminalLifecycle(runner: HostedReviewSitterRunner, snapshot: HostedReviewSnapshot): void {
    if (snapshot.lifecycle !== 'merged' && snapshot.lifecycle !== 'closed') {
      return
    }
    if (hasRecordedLifecycle(runner.ledger, snapshot.lifecycle)) {
      return
    }
    const entry: LifecycleLedgerEntry = {
      kind: 'lifecycle',
      eventId: randomUUID(),
      atMs: Date.now(),
      state: snapshot.lifecycle,
      headSha: snapshot.headSha
    }
    this.append(runner, entry)
    this.notify(
      runner.definition,
      snapshot.lifecycle === 'merged' ? 'PR Sitter: review merged' : 'PR Sitter: review closed',
      snapshot.lifecycle === 'merged'
        ? `#${runner.definition.reviewNumber} merged. Workspace left unchanged.`
        : `#${runner.definition.reviewNumber} closed without merging.`,
      entry.eventId
    )
  }

  checkpointActiveTime(
    runner: HostedReviewSitterRunner,
    source: 'tick' | 'pause' | 'shutdown',
    suspended: boolean,
    options: { allowRetired?: boolean; serviceStopped?: boolean } = {}
  ): void {
    if (
      (!this.isCurrent(runner) && !options.allowRetired) ||
      runner.activeCheckpointAtMs === null ||
      suspended
    ) {
      return
    }
    const now = performance.now()
    const activeMs = Math.min(
      MAX_UNOBSERVED_ACTIVE_DELTA_MS,
      Math.max(0, Math.floor(now - runner.activeCheckpointAtMs))
    )
    if (activeMs <= 0) {
      return
    }
    const entry: HostedReviewSitterLedgerEntry = {
      kind: 'active-time',
      eventId: randomUUID(),
      atMs: Date.now(),
      activeMs,
      source
    }
    if (options.allowRetired) {
      this.appendOutcome(runner, entry, options.serviceStopped ?? false)
    } else {
      this.append(runner, entry)
    }
    runner.activeCheckpointAtMs = now
  }

  statusFor(
    definition: HostedReviewSitterDefinition,
    runner: HostedReviewSitterRunner | undefined
  ): HostedReviewSitterStatus {
    const ledger = runner?.ledger ?? this.journal.read(definition.id)
    if (!definition.enabled) {
      return {
        sitterId: definition.id,
        enabled: false,
        state: 'disabled',
        reason: 'sitter-disabled',
        activeTimeMs: getActiveTimeMs(ledger),
        remainingBudgetMs: getRemainingBudgetMs(ledger, definition.activeBudgetMs),
        desiredAction: null,
        discrepancies: []
      }
    }
    const remainingBudgetMs = getRemainingBudgetMs(ledger, definition.activeBudgetMs)
    if (remainingBudgetMs <= 0) {
      return this.budgetExhaustedStatus(definition, ledger, runner?.status?.discrepancies ?? [])
    }
    if (runner?.status) {
      return {
        ...runner.status,
        activeTimeMs: getActiveTimeMs(ledger),
        remainingBudgetMs
      }
    }
    return {
      sitterId: definition.id,
      enabled: true,
      state: 'watching',
      reason: 'awaiting-provider-sync',
      activeTimeMs: getActiveTimeMs(ledger),
      remainingBudgetMs,
      desiredAction: null,
      discrepancies: []
    }
  }

  budgetExhaustedStatus(runner: HostedReviewSitterRunner): HostedReviewSitterStatus
  budgetExhaustedStatus(
    definition: HostedReviewSitterDefinition,
    ledger: HostedReviewSitterLedger,
    discrepancies: HostedReviewSitterStatus['discrepancies']
  ): HostedReviewSitterStatus
  budgetExhaustedStatus(
    runnerOrDefinition: HostedReviewSitterRunner | HostedReviewSitterDefinition,
    ledger?: HostedReviewSitterLedger,
    discrepancies: HostedReviewSitterStatus['discrepancies'] = []
  ): HostedReviewSitterStatus {
    const definition =
      'definition' in runnerOrDefinition ? runnerOrDefinition.definition : runnerOrDefinition
    const currentLedger = 'ledger' in runnerOrDefinition ? runnerOrDefinition.ledger : ledger
    if (!currentLedger) {
      throw new Error('Hosted review sitter budget status requires a ledger')
    }
    return {
      sitterId: definition.id,
      enabled: true,
      state: 'budget-exhausted',
      reason: 'active-time-budget-exhausted',
      activeTimeMs: getActiveTimeMs(currentLedger),
      remainingBudgetMs: 0,
      desiredAction: null,
      discrepancies:
        'status' in runnerOrDefinition
          ? (runnerOrDefinition.status?.discrepancies ?? [])
          : discrepancies
    }
  }

  errorStatus(runner: HostedReviewSitterRunner, message: string): HostedReviewSitterStatus {
    return {
      sitterId: runner.definition.id,
      enabled: true,
      state: 'held',
      reason: `provider-error:${message}`,
      activeTimeMs: getActiveTimeMs(runner.ledger),
      remainingBudgetMs: getRemainingBudgetMs(runner.ledger, runner.definition.activeBudgetMs),
      desiredAction: null,
      discrepancies: runner.status?.discrepancies ?? []
    }
  }

  private appendUnchecked(
    runner: HostedReviewSitterRunner,
    entry: HostedReviewSitterLedgerEntry
  ): void {
    this.journal.append(runner.definition.id, entry)
    runner.ledger = {
      sitterId: runner.definition.id,
      entries: [...runner.ledger.entries, entry]
    }
  }
}

export { ACTIVE_TIME_CHECKPOINT_MS }
