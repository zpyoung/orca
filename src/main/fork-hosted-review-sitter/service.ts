import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { powerMonitor } from 'electron'
import type {
  HostedReviewSitterArmInput,
  HostedReviewSitterListEntry
} from '../../shared/fork-hosted-review-sitter/api'
import {
  SITTER_RAPID_POLL_MS,
  approvalScopeForAction,
  computeDesiredAction,
  deriveActionApprovalDiscrepancy,
  deriveHostedReviewSitterStatus,
  gateDesiredAction,
  getActiveTimeMs,
  getInFlightActions,
  getRemainingBudgetMs,
  type ActionApprovalScope,
  type HostedReviewSitterDefinition,
  type HostedReviewSitterLedger
} from '../../shared/fork-hosted-review-sitter'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { authorizeHostedReviewSitterDefinition } from './definition'
import { HostedReviewSitterJournalStore } from './journal-store'
import {
  createHostedReviewSitterProvider,
  type HostedReviewSitterProviderAdapter
} from './provider'
import {
  createHostedReviewSitterAgentActuator,
  type HostedReviewSitterAgentActuator
} from './agent'
import {
  ACTIVE_TIME_CHECKPOINT_MS,
  HostedReviewSitterLedgerLifecycle,
  createHostedReviewSitterRunner,
  type HostedReviewSitterRunner as SitterRunner
} from './service-ledger'
import { HostedReviewSitterActionExecutor, actionOwnsSitterAgent } from './service-action-executor'
import { HostedReviewSitterRunnerLoop } from './service-runner-loop'
import { notifyHostedReviewSitter } from './service-notification'

function scopesEqual(left: ActionApprovalScope, right: ActionApprovalScope): boolean {
  return (
    left.action === right.action &&
    left.headSha === right.headSha &&
    left.evidenceKey === right.evidenceKey &&
    left.preparedCommitSha === right.preparedCommitSha
  )
}

export class HostedReviewSitterService {
  private readonly runners = new Map<string, SitterRunner>()
  private definitionOperationTail: Promise<void> = Promise.resolve()
  private readonly sitterAuthorityEpochs = new Map<string, number>()
  private stopAllAuthorityEpoch = 0
  private checkpointTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private stopped = false
  private suspended = false

  private readonly ledgerLifecycle: HostedReviewSitterLedgerLifecycle
  private readonly actionExecutor: HostedReviewSitterActionExecutor
  private readonly runnerLoop: HostedReviewSitterRunnerLoop
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly store: Store,
    private readonly journal: HostedReviewSitterJournalStore,
    provider: HostedReviewSitterProviderAdapter,
    actuator: HostedReviewSitterAgentActuator
  ) {
    this.ledgerLifecycle = new HostedReviewSitterLedgerLifecycle(
      journal,
      (runner) => this.isCurrent(runner),
      (definition, title, body, notificationId) =>
        notifyHostedReviewSitter(this.store, definition, title, body, notificationId)
    )
    this.actionExecutor = new HostedReviewSitterActionExecutor(
      provider,
      actuator,
      this.ledgerLifecycle,
      (runner) => this.isCurrent(runner),
      () => this.suspended,
      () => this.stopped,
      (definition, title, body, notificationId) =>
        notifyHostedReviewSitter(this.store, definition, title, body, notificationId)
    )
    this.runnerLoop = new HostedReviewSitterRunnerLoop(
      this.actionExecutor,
      this.ledgerLifecycle,
      (runner) => this.isCurrent(runner),
      () => this.suspended
    )
  }

  start(): void {
    if (this.started || this.stopped) {
      return
    }
    this.started = true
    for (const definition of this.store.getHostedReviewSitterDefinitions()) {
      if (!definition.enabled) {
        continue
      }
      const runner = this.createRunner(definition)
      this.runners.set(definition.id, runner)
      void this.runnerLoop
        .runSerialized(runner, () => this.actionExecutor.recoverInterruptedActions(runner))
        .then(() => this.runnerLoop.schedule(runner, 0))
        .catch((error) => {
          console.warn('[hosted-review-sitter] action recovery failed:', error)
          this.runnerLoop.schedule(runner, SITTER_RAPID_POLL_MS)
        })
    }
    this.checkpointTimer = setInterval(() => {
      for (const runner of this.runners.values()) {
        try {
          this.ledgerLifecycle.checkpointActiveTime(runner, 'tick', this.suspended)
        } catch (error) {
          console.warn('[hosted-review-sitter] active-time checkpoint failed:', error)
        }
        if (getRemainingBudgetMs(runner.ledger, runner.definition.activeBudgetMs) <= 0) {
          runner.activeCheckpointAtMs = null
          runner.actionController?.abort(
            new Error('Hosted review sitter active-time budget exhausted')
          )
        }
      }
    }, ACTIVE_TIME_CHECKPOINT_MS)
    powerMonitor.on('suspend', this.handleSuspend)
    powerMonitor.on('resume', this.handleResume)
  }

  async list(): Promise<HostedReviewSitterListEntry[]> {
    return this.store.getHostedReviewSitterDefinitions().map((definition) => {
      const runner = this.runners.get(definition.id)
      return {
        definition,
        status: this.ledgerLifecycle.statusFor(definition, runner)
      }
    })
  }

  async arm(input: HostedReviewSitterArmInput): Promise<HostedReviewSitterListEntry> {
    if (this.stopped) {
      throw new Error('Hosted review sitter service is stopped')
    }
    const definitions = this.store.getHostedReviewSitterDefinitions()
    const candidate = definitions.find(
      (definition) =>
        definition.repoId === input.repoId &&
        definition.provider === input.provider &&
        definition.reviewNumber === input.reviewNumber
    )
    const authority = {
      stopAllEpoch: this.stopAllAuthorityEpoch,
      candidateId: candidate?.id,
      candidateEpoch: candidate ? this.nextSitterAuthorityEpoch(candidate.id) : undefined,
      rearm: candidate ? !candidate.enabled : false,
      previousRunner: candidate ? this.fenceRunner(candidate.id) : undefined
    }
    if (candidate?.enabled) {
      this.persistDefinitionsDisabled(new Set([candidate.id]))
    }
    return this.enqueueDefinitionOperation(() => this.armInternal(input, authority))
  }

  private async armInternal(
    input: HostedReviewSitterArmInput,
    authority: {
      stopAllEpoch: number
      candidateId: string | undefined
      candidateEpoch: number | undefined
      rearm: boolean
      previousRunner: SitterRunner | undefined
    }
  ): Promise<HostedReviewSitterListEntry> {
    this.assertArmAuthority(authority.stopAllEpoch)
    const authorized = await authorizeHostedReviewSitterDefinition(this.runtime, this.store, input)
    this.assertArmAuthority(authority.stopAllEpoch)
    const definitions = this.store.getHostedReviewSitterDefinitions()
    const existing = definitions.find(
      (definition) =>
        definition.repoId === authorized.repoId &&
        definition.provider === authorized.provider &&
        definition.reviewNumber === authorized.reviewNumber
    )
    const id = existing?.id ?? randomUUID()
    let sitterEpoch = authority.candidateId === id ? authority.candidateEpoch : undefined
    let previousRunner = authority.candidateId === id ? authority.previousRunner : undefined
    let rearm =
      authority.candidateId === id ? authority.rearm : Boolean(existing && !existing.enabled)
    if (sitterEpoch === undefined) {
      sitterEpoch = this.nextSitterAuthorityEpoch(id)
      previousRunner = this.fenceRunner(id)
      if (existing?.enabled) {
        this.persistDefinitionsDisabled(new Set([id]))
      }
      rearm = Boolean(existing && !existing.enabled)
    }
    this.assertArmAuthority(authority.stopAllEpoch, id, sitterEpoch)
    if (previousRunner) {
      await previousRunner.operationTail
      this.assertArmAuthority(authority.stopAllEpoch, id, sitterEpoch)
    }
    const priorLedger = this.journal.read(id)
    const definition: HostedReviewSitterDefinition = {
      ...authorized,
      id,
      enabled: true,
      activeBudgetMs: rearm
        ? getActiveTimeMs(priorLedger) + authorized.activeBudgetMs
        : authorized.activeBudgetMs
    }
    const snapshot = await this.actionExecutor.readSnapshotDefinition(definition, true)
    this.assertArmAuthority(authority.stopAllEpoch, id, sitterEpoch)

    const currentDefinitions = this.store.getHostedReviewSitterDefinitions()
    this.store.replaceHostedReviewSitterDefinitionsAndFlush(
      currentDefinitions.filter((candidate) => candidate.id !== id).concat(definition)
    )
    const runner = this.createRunner(definition)
    runner.snapshot = snapshot
    runner.lastFullResyncAtMs = Date.now()
    this.runners.set(id, runner)
    if (rearm) {
      this.ledgerLifecycle.acknowledgeRearm(runner)
    }
    try {
      await this.runnerLoop.runSerialized(runner, () =>
        this.actionExecutor.recoverInterruptedActions(runner)
      )
    } catch (error) {
      if (!this.isCurrent(runner)) {
        throw new Error('Hosted review sitter was replaced while arming')
      }
      runner.consecutiveErrors = 1
      runner.status = this.ledgerLifecycle.errorStatus(
        runner,
        error instanceof Error ? error.message : String(error)
      )
      this.runnerLoop.schedule(runner, SITTER_RAPID_POLL_MS)
      return { definition, status: runner.status }
    }
    if (!this.isCurrent(runner)) {
      throw new Error('Hosted review sitter was replaced while arming')
    }
    const interruptedPreparation = getInFlightActions(runner.ledger).find(
      (entry) =>
        entry.action.kind === 'prepare-fix' || entry.action.kind === 'prepare-conflict-resolution'
    )
    const contention = await this.actionExecutor.contention(
      definition,
      interruptedPreparation
        ? actionOwnsSitterAgent(interruptedPreparation.action, interruptedPreparation.actionId)
        : undefined
    )
    if (!this.isCurrent(runner)) {
      throw new Error('Hosted review sitter was replaced while arming')
    }
    runner.status = deriveHostedReviewSitterStatus(snapshot, definition, runner.ledger, contention)
    this.runnerLoop.schedule(runner, 0)
    return { definition, status: runner.status }
  }

  async stop(id: string): Promise<void> {
    if (this.stopped) {
      return
    }
    this.nextSitterAuthorityEpoch(id)
    this.fenceRunner(id)
    this.persistDefinitionsDisabled(new Set([id]))
  }

  async stopAll(): Promise<void> {
    if (this.stopped) {
      return
    }
    this.stopAllAuthorityEpoch += 1
    for (const definition of this.store.getHostedReviewSitterDefinitions()) {
      this.nextSitterAuthorityEpoch(definition.id)
    }
    for (const runner of this.runners.values()) {
      this.stopRunner(runner, 'pause')
    }
    this.runners.clear()
    this.persistDefinitionsDisabled()
  }

  async approve(id: string, scope: ActionApprovalScope): Promise<void> {
    const runner = this.runners.get(id)
    if (!runner || !runner.definition.enabled || !this.isCurrent(runner)) {
      throw new Error('Hosted review sitter is not active')
    }
    await this.runnerLoop.runSerialized(runner, async () => {
      if (!this.isCurrent(runner)) {
        throw new Error('Hosted review sitter stopped before approval')
      }
      const snapshot = await this.actionExecutor.readSnapshotDefinition(runner.definition, true)
      if (!this.isCurrent(runner)) {
        throw new Error('Hosted review sitter stopped before approval')
      }
      runner.snapshot = snapshot
      runner.lastFullResyncAtMs = Date.now()
      const action = computeDesiredAction(snapshot, runner.definition, runner.ledger)
      if (
        !action ||
        runner.definition.capabilities[action.capability] !== 'gated' ||
        !scopesEqual(approvalScopeForAction(action), scope)
      ) {
        throw new Error('Approval no longer matches the current hosted review action')
      }
      const contention = await this.actionExecutor.contention(
        runner.definition,
        actionOwnsSitterAgent(action)
      )
      const gate = gateDesiredAction(action, snapshot, runner.definition, runner.ledger, contention)
      if (gate.verdict !== 'hold' || gate.reason !== 'awaiting-approval') {
        throw new Error('Hosted review action is not awaiting this approval')
      }

      const discrepancy = deriveActionApprovalDiscrepancy(action, runner.ledger)
      this.ledgerLifecycle.appendDiscrepancyIfChanged(runner, discrepancy, true)
      this.ledgerLifecycle.append(runner, {
        kind: 'approval',
        eventId: randomUUID(),
        atMs: Date.now(),
        scope,
        decision: 'approved'
      })
      const acknowledged = deriveActionApprovalDiscrepancy(action, runner.ledger)
      this.ledgerLifecycle.appendDiscrepancyIfChanged(runner, acknowledged, false)
      runner.status = deriveHostedReviewSitterStatus(
        snapshot,
        runner.definition,
        runner.ledger,
        contention
      )
      this.runnerLoop.schedule(runner, 0)
    })
  }

  ledger(id: string): HostedReviewSitterLedger {
    const definition = this.store
      .getHostedReviewSitterDefinitions()
      .find((candidate) => candidate.id === id)
    if (!definition) {
      throw new Error('Unknown hosted review sitter')
    }
    const runner = this.runners.get(id)
    return runner ? structuredClone(runner.ledger) : this.journal.read(id)
  }

  stopForShutdown(): void {
    if (this.stopped) {
      return
    }
    this.stopAllAuthorityEpoch += 1
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer)
    }
    this.checkpointTimer = null
    powerMonitor.off('suspend', this.handleSuspend)
    powerMonitor.off('resume', this.handleResume)
    for (const runner of this.runners.values()) {
      this.stopRunner(runner, 'shutdown')
    }
    this.stopped = true
    this.runners.clear()
    this.journal.close()
  }

  private readonly handleSuspend = (): void => {
    if (this.stopped || this.suspended) {
      return
    }
    this.suspended = true
    for (const runner of this.runners.values()) {
      if (runner.timer) {
        clearTimeout(runner.timer)
        runner.timer = null
      }
      try {
        this.ledgerLifecycle.checkpointActiveTime(runner, 'pause', false)
      } catch (error) {
        console.warn('[hosted-review-sitter] suspend checkpoint failed:', error)
      } finally {
        runner.activeCheckpointAtMs = null
      }
    }
  }

  private readonly handleResume = (): void => {
    if (this.stopped || !this.suspended) {
      return
    }
    this.suspended = false
    const now = performance.now()
    for (const runner of this.runners.values()) {
      runner.activeCheckpointAtMs = now
      runner.lastFullResyncAtMs = null
      this.runnerLoop.schedule(runner, 0)
    }
  }

  private createRunner(definition: HostedReviewSitterDefinition): SitterRunner {
    return createHostedReviewSitterRunner(definition, this.journal)
  }

  private stopRunner(runner: SitterRunner, checkpointSource: 'pause' | 'shutdown'): void {
    runner.fenced = true
    runner.reconcileAgain = false
    if (runner.timer) {
      clearTimeout(runner.timer)
      runner.timer = null
    }
    runner.actionController?.abort(new Error('Hosted review sitter stopped'))
    runner.actionController = null
    try {
      this.ledgerLifecycle.checkpointActiveTime(runner, checkpointSource, this.suspended, {
        allowRetired: true,
        serviceStopped: this.stopped
      })
    } catch (error) {
      console.warn('[hosted-review-sitter] stop checkpoint failed:', error)
    } finally {
      runner.activeCheckpointAtMs = null
    }
  }

  private isCurrent(runner: SitterRunner): boolean {
    return !this.stopped && !runner.fenced && this.runners.get(runner.definition.id) === runner
  }

  private nextSitterAuthorityEpoch(id: string): number {
    const epoch = (this.sitterAuthorityEpochs.get(id) ?? 0) + 1
    this.sitterAuthorityEpochs.set(id, epoch)
    return epoch
  }

  private assertArmAuthority(stopAllEpoch: number, sitterId?: string, sitterEpoch?: number): void {
    if (
      this.stopped ||
      stopAllEpoch !== this.stopAllAuthorityEpoch ||
      (sitterId !== undefined &&
        (sitterEpoch === undefined || this.sitterAuthorityEpochs.get(sitterId) !== sitterEpoch))
    ) {
      throw new Error('Hosted review sitter arming authority was revoked')
    }
  }

  private fenceRunner(id: string): SitterRunner | undefined {
    const runner = this.runners.get(id)
    if (!runner) {
      return undefined
    }
    this.stopRunner(runner, 'pause')
    this.runners.delete(id)
    return runner
  }

  private persistDefinitionsDisabled(ids?: ReadonlySet<string>): void {
    const definitions = this.store.getHostedReviewSitterDefinitions()
    let changed = false
    const disabled = definitions.map((definition) => {
      if (!definition.enabled || (ids && !ids.has(definition.id))) {
        return definition
      }
      changed = true
      return { ...definition, enabled: false }
    })
    if (changed) {
      this.store.replaceHostedReviewSitterDefinitionsAndFlush(disabled)
    }
  }

  private enqueueDefinitionOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.definitionOperationTail.then(operation)
    this.definitionOperationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export function createHostedReviewSitterService(
  runtime: OrcaRuntimeService,
  store: Store
): HostedReviewSitterService {
  return new HostedReviewSitterService(
    runtime,
    store,
    new HostedReviewSitterJournalStore(store.getProfileStorageDirectory()),
    createHostedReviewSitterProvider(runtime, store),
    createHostedReviewSitterAgentActuator(runtime, store)
  )
}
