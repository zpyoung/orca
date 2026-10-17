import { decideNext, type LoopAction } from '../../shared/fork-loops/loop-decision'
import { composeIterationPrompt } from '../../shared/fork-loops/loop-prompt'
import type {
  IterationEvidence,
  IterationPhase,
  IterationRecord,
  NeedsYouReason,
  PauseReason
} from '../../shared/fork-loops/loop-types'
import { LOOP_USER_IDLE_MS } from './input-attribution'
import type { IterationSettlement } from './iteration-observer'
import {
  abortableSleep,
  awaitAgentReady,
  errorMessage,
  observeUntilSettled,
  relaunchLoopAgent,
  resolvePane,
  sendAgentPrompt
} from './loop-agent-session'
import type { QueueItem, StoredLoop, LoopPatch } from './loop-database'
import type { IterationContext, LoopDriverDeps } from './loop-driver-types'
import {
  buildRuntimeState,
  gatherIterationEvidence,
  skippedWallClockTicks,
  toRecord
} from './loop-iteration-evidence'
import { appendLoopLogLine, loopNotesPath } from './loop-notes-file'

export type {
  LoopDriverDeps,
  LoopDriverRuntime,
  LoopEvidenceTools,
  LoopTargets
} from './loop-driver-types'

const MAX_WAIT_SLICE_MS = 30_000

/**
 * Runs one loop: asks `decideNext` what to do, carries the action out against the runtime, and
 * persists each iteration's evidence. It never answers an agent prompt and never writes while the
 * user is typing or the agent is busy. Every state transition is committed and published once.
 */
export class LoopDriver {
  private running = false
  private disposed = false
  private userPaused = false
  private stopRequested: 'after-iteration' | 'now' | null = null
  private latest: IterationEvidence | null = null
  private sessionUsed = false
  private preambleSent = false
  private iteration: { n: number; startedAt: number; phase: IterationPhase } | null = null
  private runningSince: number | null = null
  private abort = new AbortController()
  private wake = new AbortController()
  private finished: Promise<void> = Promise.resolve()

  constructor(
    private readonly loopId: string,
    private readonly deps: LoopDriverDeps
  ) {}

  current(): { n: number; startedAt: number; phase: IterationPhase } | null {
    return this.iteration
  }

  /** Starts the decide-act loop if it is not already running. */
  start(): void {
    if (this.running || this.disposed) {
      return
    }
    this.running = true
    this.runningSince = this.now()
    this.finished = this.run()
      .catch((error: unknown) => this.crashLoop(error))
      .finally(() => {
        this.running = false
      })
  }

  /** Clears holds and forgets the last evidence so a resumed loop is judged afresh. */
  resume(): void {
    this.userPaused = false
    this.stopRequested = null
    this.latest = null
    this.start()
  }

  requestPause(): void {
    this.userPaused = true
    this.poke()
  }

  requestStop(mode: 'after-iteration' | 'now'): void {
    this.stopRequested = mode
    if (mode === 'now') {
      this.abort.abort()
    }
    this.poke()
  }

  /** Stops without touching loop state so the next launch reconciles the open iteration. */
  async shutdown(): Promise<void> {
    if (!this.disposed) {
      this.accrue()
      this.disposed = true
    }
    this.abort.abort()
    this.poke()
    await this.finished
  }

  whenIdle(): Promise<void> {
    return this.finished
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private poke(): void {
    this.wake.abort()
    this.wake = new AbortController()
  }

  private row(): StoredLoop {
    const row = this.deps.store.getLoop(this.loopId)
    if (!row) {
      throw new Error(`Loop ${this.loopId} not found`)
    }
    return row
  }

  private history(): IterationRecord[] {
    return this.deps.store
      .listIterations(this.loopId)
      .map(toRecord)
      .filter((record): record is IterationRecord => record !== null)
  }

  private async run(): Promise<void> {
    await Promise.resolve()
    while (!this.disposed) {
      const action = this.decide()
      switch (action.kind) {
        case 'start-iteration':
          await this.runIteration(action.freshSession, action.promptSource, false)
          break
        case 'retry-crashed':
          await this.runIteration(true, 'repeat', true)
          break
        case 'wait':
          await this.waitFor(action)
          break
        case 'complete':
          this.conclude('completed')
          return
        case 'pause':
          if (action.reason === 'user' && action.detail === 'stop-requested') {
            this.conclude('stopped')
          } else {
            this.pause(action.reason, action.detail)
          }
          return
      }
    }
  }

  private decide(): LoopAction {
    const loop = this.row()
    const history = this.history()
    const last = history.at(-1) ?? null
    const promptSource = loop.config.promptSource
    return decideNext({
      loop: loop.config,
      state: buildRuntimeState(loop, last, history),
      history,
      latest: this.latest,
      now: this.now(),
      hold: {
        userPaused: this.userPaused,
        stopRequested: this.stopRequested,
        awaitingApproval: this.agentBusy(loop),
        connection: 'live',
        userTyping: this.userTyping(loop)
      },
      ...(promptSource.kind === 'queue' ? { queue: this.deps.store.listQueue(this.loopId) } : {})
    })
  }

  private userTyping(loop: StoredLoop): boolean {
    const pane = resolvePane(this.deps.runtime, loop.paneKey)
    return pane !== null && !this.deps.inputAttribution.userIdleFor(pane.ptyId, LOOP_USER_IDLE_MS)
  }

  private agentBusy(loop: StoredLoop): boolean {
    const read = this.deps.runtime.getAgentStatusRowsForPane
    return loop.paneKey !== null && typeof read === 'function'
      ? read.call(this.deps.runtime, loop.paneKey).some((row) => row.state === 'working')
      : false
  }

  private async waitFor(action: Extract<LoopAction, { kind: 'wait' }>): Promise<void> {
    const until = typeof action.until === 'number' ? action.until : null
    this.accrue()
    if (until !== null && this.row().nextIterationAt !== until) {
      this.commit({ nextIterationAt: until })
    }
    const ms = until === null ? (this.deps.pollMs ?? 1000) : until - this.now()
    await (this.deps.sleep ?? abortableSleep)(
      Math.max(0, Math.min(ms, MAX_WAIT_SLICE_MS)),
      this.wake.signal
    )
  }

  private accrue(): void {
    if (this.runningSince === null) {
      return
    }
    const at = this.now()
    const row = this.row()
    this.deps.store.updateLoop(this.loopId, { activeMs: row.activeMs + (at - this.runningSince) })
    this.runningSince = at
  }

  /** Persists `patch`, sets or clears the live phase, and publishes exactly one change. */
  private commit(patch: LoopPatch, phase?: IterationPhase | null): StoredLoop {
    if (phase === null) {
      this.iteration = null
    } else if (phase !== undefined && this.iteration) {
      this.iteration = { ...this.iteration, phase }
    }
    const row = this.deps.store.updateLoop(this.loopId, patch)
    if (!this.disposed) {
      this.deps.changed(this.loopId)
    }
    return row
  }

  private pause(reason: PauseReason, detail?: string): void {
    this.accrue()
    this.runningSince = null
    const row = this.commit(
      { state: 'paused', pauseReason: reason, pauseDetail: detail ?? null, nextIterationAt: null },
      null
    )
    if (reason.startsWith('cap-')) {
      this.deps.notify(row, 'cap-reached', reason)
    } else if (reason !== 'user' && reason !== 'interrupted-by-restart') {
      this.deps.notify(row, 'paused', detail ? `${reason}: ${detail}` : reason)
    }
  }

  private conclude(state: 'completed' | 'stopped'): void {
    this.accrue()
    this.runningSince = null
    const row = this.commit(
      { state, pauseReason: null, pauseDetail: null, nextIterationAt: null },
      null
    )
    if (state === 'completed') {
      this.deps.notify(row, 'completed')
    }
  }

  private crashLoop(error: unknown): void {
    try {
      this.pause('crashed', errorMessage(error))
    } catch (persistError) {
      console.warn('[loops] driver failed and could not persist its state:', persistError)
    }
  }

  private enterNeedsYou(reason: NeedsYouReason): void {
    this.accrue()
    this.runningSince = null
    const row = this.commit({ state: 'needs-you' }, 'needs-you')
    this.deps.notify(row, 'needs-you', reason)
  }

  private leaveNeedsYou(phase: IterationPhase): void {
    this.runningSince = this.now()
    this.commit({ state: 'running' }, phase)
  }

  private queueItemFor(
    source: 'repeat' | { queueItemId: string },
    reuseInFlight: boolean
  ): QueueItem | null {
    const { store } = this.deps
    const items = store.listQueue(this.loopId)
    const inFlight = items.find((item) => item.state === 'in-flight')
    if (reuseInFlight && inFlight) {
      return inFlight
    }
    if (source === 'repeat') {
      return null
    }
    const chosen = items.find((item) => item.id === source.queueItemId) ?? null
    if (chosen?.state === 'done') {
      for (const item of items) {
        store.setQueueItemState(this.loopId, item.id, 'pending')
      }
    }
    if (chosen) {
      store.setQueueItemState(this.loopId, chosen.id, 'in-flight')
    }
    return chosen
  }

  private async runIteration(
    freshSession: boolean,
    source: 'repeat' | { queueItemId: string },
    isRetry: boolean
  ): Promise<void> {
    const { store, tools } = this.deps
    let loop = this.row()
    const rows = store.listIterations(this.loopId, { limit: 1 })
    const lastRow = rows.at(-1) ?? null
    const reRun = lastRow?.endReason === 'interrupted'
    const n =
      isRetry || reRun ? (lastRow?.n ?? loop.iterationsCompleted + 1) : loop.iterationsCompleted + 1
    const attempt = isRetry || reRun ? (lastRow?.attempt ?? -1) + 1 : 0
    const startedAt = this.now()
    store.insertIteration(this.loopId, { n, attempt, promptSent: '', startedAt })
    this.abort = new AbortController()
    if (this.stopRequested === 'now') {
      this.abort.abort()
    }
    this.iteration = { n, startedAt, phase: 'sending' }
    this.accrue()
    this.commit({})
    const targets = await this.deps.targets(loop.worktreeId).catch(() => null)
    const ctx: IterationContext = {
      n,
      attempt,
      startedAt,
      loop,
      targets,
      before: null,
      usageBefore: null,
      error: null
    }
    const item = this.queueItemFor(source, isRetry || reRun)

    let pane = resolvePane(this.deps.runtime, loop.paneKey)
    if (!pane || isRetry || (freshSession && this.sessionUsed)) {
      this.commit({}, 'relaunching')
      try {
        const launched = await relaunchLoopAgent(this.deps.runtime, loop, pane)
        this.commit(
          { tabId: launched.tabId, paneKey: launched.paneKey, ptyId: launched.ptyId },
          'sending'
        )
        pane = { handle: launched.handle, ptyId: launched.ptyId }
        ctx.error = launched.closeError
        loop = this.row()
        ctx.loop = loop
        this.sessionUsed = false
        this.preambleSent = false
      } catch (error) {
        return this.endIteration(ctx, { kind: 'crashed', exitCode: null }, errorMessage(error))
      }
      const ready = await awaitAgentReady({
        runtime: this.deps.runtime,
        handle: pane.handle,
        signal: this.abort.signal,
        pollMs: this.deps.pollMs,
        now: () => this.now(),
        onBlocked: (reason) => this.enterNeedsYou(reason),
        onUnblocked: () => this.leaveNeedsYou('sending')
      })
      if (ready !== 'ready') {
        return this.endIteration(ctx, {
          kind: ready === 'aborted' ? 'aborted' : 'crashed',
          exitCode: null
        })
      }
    }

    ctx.before = targets ? await tools.snapshotTree(targets.workspace) : null
    ctx.usageBefore = loop.paneKey
      ? await tools.readUsage(loop.paneKey, loop.worktreeId, loop.agent)
      : null
    const prompt = this.composePrompt(loop, ctx, item)
    const sentAt = this.now()
    store.updateIteration(this.loopId, n, attempt, { promptSent: prompt })
    const freshForUsage = !this.sessionUsed
    try {
      await sendAgentPrompt(this.deps.runtime, this.deps.inputAttribution, pane, prompt, () =>
        this.now()
      )
    } catch (error) {
      return this.endIteration(ctx, { kind: 'crashed', exitCode: null }, errorMessage(error))
    }
    this.sessionUsed = true
    this.preambleSent = true
    this.commit({}, 'working')

    const settlement = await observeUntilSettled({
      runtime: this.deps.runtime,
      observer: this.deps.observer,
      pane,
      paneKey: () => this.row().paneKey ?? loop.paneKey ?? '',
      sentAt,
      signal: this.abort.signal,
      pollMs: this.deps.pollMs,
      sleep: this.deps.sleep,
      onNeedsYou: (reason) => this.enterNeedsYou(reason),
      onResumed: () => this.leaveNeedsYou('working'),
      onPhase: (phase) => this.commit({}, phase)
    })
    if (this.disposed) {
      return
    }
    if (freshForUsage && !ctx.usageBefore) {
      ctx.usageBefore = { providerSessionId: '', costUsd: 0, totalTokens: 0 }
    }
    await this.endIteration(ctx, settlement, undefined, pane.handle)
    if (item && settlement.kind === 'settled') {
      store.setQueueItemState(this.loopId, item.id, 'done')
    }
  }

  private composePrompt(loop: StoredLoop, ctx: IterationContext, item: QueueItem | null): string {
    const { config } = loop
    const history = this.history()
    const body =
      item?.body ?? (config.promptSource.kind === 'repeat' ? config.promptSource.body : '')
    const notes = this.deps.store.takePendingSteerNotes(this.loopId, ctx.n).map((note) => note.body)
    return composeIterationPrompt({
      loop: config,
      iteration: ctx.n,
      maxIterations: config.caps.maxIterations ?? null,
      previousCheck: history.at(-1)?.check ?? null,
      steerNotes: notes,
      body,
      notesPath: ctx.targets
        ? loopNotesPath(ctx.targets.workspace, loop.slug)
        : `.orca/loops/${loop.slug}/notes.md`,
      includePreamble: !this.preambleSent
    })
  }

  private async endIteration(
    ctx: IterationContext,
    settlement: IterationSettlement,
    failure?: string,
    paneHandle?: string
  ): Promise<void> {
    if (this.disposed || settlement.kind === 'unverifiable') {
      return
    }
    const { store, tools } = this.deps
    const stopped = settlement.kind === 'aborted'
    const gathered =
      settlement.kind === 'settled'
        ? await gatherIterationEvidence({
            ctx,
            tools,
            runtime: this.deps.runtime,
            paneHandle,
            settlement,
            onPhase: (phase) => this.commit({}, phase)
          })
        : null
    const endedAt = this.now()
    const evidence = {
      check: gathered?.check ?? null,
      evaluator: gathered?.evaluator ?? null,
      diff: gathered?.diff ?? null,
      treeBefore: gathered?.treeBefore ?? ctx.before?.treeId ?? null,
      treeAfter: gathered?.treeAfter ?? null,
      costUsd: gathered?.costUsd ?? null,
      markers: gathered?.markers ?? [],
      protectedPathHits: gathered?.protectedPathHits ?? [],
      checkpointCommit: gathered?.checkpointCommit ?? null
    }
    const endReason = stopped ? 'stopped' : settlement.kind === 'crashed' ? 'crashed' : 'settled'
    const error = failure ?? gathered?.error ?? ctx.error
    store.updateIteration(this.loopId, ctx.n, ctx.attempt, {
      endedAt,
      endReason,
      ...evidence,
      ...(gathered ? { outputTail: gathered.outputTail } : {}),
      error
    })
    const usageLimit = settlement.kind === 'aborted' ? null : tools.readUsageLimit(ctx.loop.agent)
    this.latest = {
      n: ctx.n,
      attempt: ctx.attempt,
      startedAt: ctx.startedAt,
      endedAt,
      endReason,
      ...evidence,
      settlement: settlement.kind,
      usageLimit
    }
    const row = this.row()
    this.accrue()
    this.commit(
      {
        iterationsCompleted: endReason === 'settled' ? ctx.n : row.iterationsCompleted,
        costUsd: evidence.costUsd === null ? row.costUsd : (row.costUsd ?? 0) + evidence.costUsd,
        skippedTicks: row.skippedTicks + skippedWallClockTicks(row, ctx.startedAt, endedAt),
        nextIterationAt: null
      },
      null
    )
    if (ctx.targets) {
      await appendLoopLogLine(ctx.targets.workspace, ctx.loop.slug, {
        n: ctx.n,
        endReason,
        checkPass: evidence.check ? evidence.check.pass : null,
        added: evidence.diff?.added ?? null,
        removed: evidence.diff?.removed ?? null,
        costUsd: evidence.costUsd
      })
    }
  }
}
