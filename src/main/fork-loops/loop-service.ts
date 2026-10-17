import { randomUUID } from 'node:crypto'
import {
  LOOP_RECENT_ITERATIONS_LIMIT,
  LoopConfigSchema,
  type LoopConfig,
  type LoopCreateInput,
  type LoopEditPatch,
  type LoopErrorCode,
  type LoopSnapshot,
  type QueueOp
} from '../../shared/fork-loops/loop-types'
import type { RuntimeTerminalFocus } from '../../shared/runtime-terminal-contracts'
import { validateLoopCheckHost, type LoopCheckTarget } from './loop-check'
import { LoopStoreError, type LoopPatch, type StoredLoop } from './loop-database'
import { LoopDriver, type LoopDriverDeps, type LoopDriverRuntime } from './loop-driver'
import { isLoopEvaluatorAvailable } from './loop-evaluator'
import { ensureLoopNotesFile } from './loop-notes-file'
import type { LoopStore } from './loop-store'

export type LoopServiceRuntime = LoopDriverRuntime & {
  focusTerminal?(
    handle: string,
    options?: { navigateHost?: boolean }
  ): Promise<RuntimeTerminalFocus>
}

export type LoopServiceDeps = {
  store: LoopStore
  runtime: LoopServiceRuntime
  driverDeps: Omit<LoopDriverDeps, 'store' | 'runtime' | 'changed' | 'notify'>
  notify: LoopDriverDeps['notify']
  closeDatabase?(): void
  isEvaluatorAvailable?(agent: LoopCreateInput['agent']): boolean
  now?(): number
  newId?(): string
}

type LoopListener = (snapshot: LoopSnapshot) => void

function fail(code: LoopErrorCode, message: string): never {
  throw new LoopStoreError(code, message)
}

function isEnded(loop: StoredLoop): boolean {
  return loop.state === 'completed' || loop.state === 'stopped'
}

function slugFor(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${base || 'loop'}-${id.slice(0, 8)}`
}

/**
 * Owns every loop in this process: persists them, runs one driver per active loop, and publishes
 * a snapshot after each mutation. Reconciliation of loops left running by a previous process
 * happens on `start()`, which every entry point also calls so the database opens lazily.
 */
export class LoopService {
  private readonly drivers = new Map<string, LoopDriver>()
  private readonly listeners = new Set<LoopListener>()
  private started = false

  constructor(private readonly deps: LoopServiceDeps) {}

  /** Idempotent. Never resumes anything: interrupted loops come back paused. */
  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    const { store } = this.deps
    const endedAt = this.now()
    for (const loop of store.listLoops()) {
      if (loop.state !== 'running' && loop.state !== 'needs-you') {
        continue
      }
      for (const row of store.listIterations(loop.id)) {
        if (row.endedAt === null) {
          store.updateIteration(loop.id, row.n, row.attempt, { endedAt, endReason: 'interrupted' })
        }
      }
      store.updateLoop(loop.id, {
        state: 'paused',
        pauseReason: 'interrupted-by-restart',
        pauseDetail: null
      })
      this.publish(loop.id)
    }
  }

  onChange(listener: LoopListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  list(filter: { worktreeId?: string } = {}): LoopSnapshot[] {
    this.start()
    return this.deps.store.listLoops(filter).map((loop) => this.snapshot(loop))
  }

  get(loopId: string): LoopSnapshot | null {
    this.start()
    const loop = this.deps.store.getLoop(loopId)
    return loop ? this.snapshot(loop) : null
  }

  async create(input: LoopCreateInput): Promise<LoopSnapshot> {
    this.start()
    const { store, runtime, driverDeps } = this.deps
    if (typeof runtime.launchAgentTerminal !== 'function') {
      fail('loop_runtime_unavailable', 'The runtime cannot launch an agent terminal')
    }
    const targets = await driverDeps.targets(input.worktreeId)
    this.validateConfig(input.agent, input.config, targets.check)
    const warnings = store
      .listLoops({ worktreeId: input.worktreeId })
      .some((loop) => loop.state === 'running' || loop.state === 'needs-you')
      ? ['worktree-has-running-loop']
      : []
    const launched = await runtime.launchAgentTerminal(`id:${input.worktreeId}`, {
      agent: input.agent,
      prompt: '',
      title: input.name,
      ...(input.launchOverrides ? { launchOverrides: input.launchOverrides } : {})
    })
    const id = this.deps.newId?.() ?? randomUUID()
    const slug = slugFor(input.name, id)
    await ensureLoopNotesFile(targets.workspace, slug).catch(() => undefined)
    store.insertLoop({
      id,
      worktreeId: input.worktreeId,
      workspaceKind: targets.workspace.kind,
      executionHostId: targets.executionHostId,
      name: input.name,
      slug,
      agent: input.agent,
      preset: input.preset,
      config: input.config,
      state: 'running',
      launchOverrides: input.launchOverrides ?? null,
      tabId: launched.tabId ?? null,
      paneKey: launched.paneKey ?? null,
      ptyId: launched.ptyId ?? null
    })
    for (const body of input.queueItems ?? []) {
      store.applyQueueOp(id, { op: 'add', body })
    }
    this.driverFor(id).start()
    return this.publish(id, warnings)
  }

  async pause(loopId: string, _mode: 'after-iteration'): Promise<LoopSnapshot> {
    const loop = this.getOrThrow(loopId)
    if (isEnded(loop)) {
      fail('loop_invalid_transition', `Loop ${loopId} has already ended`)
    }
    if (loop.state === 'paused') {
      return this.snapshot(loop)
    }
    this.driverFor(loopId).requestPause()
    return this.publish(loopId)
  }

  async resume(loopId: string, opts: { addIterations?: number } = {}): Promise<LoopSnapshot> {
    const loop = this.getOrThrow(loopId)
    if (loop.state !== 'paused') {
      fail('loop_invalid_transition', `Loop ${loopId} is ${loop.state}, not paused`)
    }
    const patch: LoopPatch = { state: 'running', pauseReason: null, pauseDetail: null }
    if (opts.addIterations) {
      const base = Math.max(loop.config.caps.maxIterations ?? 0, loop.iterationsCompleted)
      patch.config = {
        ...loop.config,
        caps: { ...loop.config.caps, maxIterations: base + opts.addIterations }
      }
    }
    this.deps.store.updateLoop(loopId, patch)
    this.driverFor(loopId).resume()
    return this.publish(loopId)
  }

  async stop(loopId: string, mode: 'after-iteration' | 'now'): Promise<LoopSnapshot> {
    const loop = this.getOrThrow(loopId)
    if (isEnded(loop)) {
      fail('loop_invalid_transition', `Loop ${loopId} has already ended`)
    }
    if (loop.state === 'paused') {
      this.deps.store.updateLoop(loopId, {
        state: 'stopped',
        pauseReason: null,
        pauseDetail: null,
        nextIterationAt: null
      })
    } else {
      this.driverFor(loopId).requestStop(mode)
    }
    return this.publish(loopId)
  }

  async steer(loopId: string, text: string): Promise<LoopSnapshot> {
    this.getOpenOrThrow(loopId)
    this.deps.store.addSteerNote(loopId, text)
    return this.publish(loopId)
  }

  async edit(loopId: string, patch: LoopEditPatch): Promise<LoopSnapshot> {
    const loop = this.getOpenOrThrow(loopId)
    const { name, ...configPatch } = patch
    const config = LoopConfigSchema.parse({ ...loop.config, ...configPatch })
    if (configPatch.done) {
      this.validateConfig(
        loop.agent,
        config,
        (await this.deps.driverDeps.targets(loop.worktreeId)).check
      )
    }
    this.deps.store.updateLoop(loopId, { config, ...(name ? { name } : {}) })
    return this.publish(loopId)
  }

  async queue(loopId: string, op: QueueOp): Promise<LoopSnapshot> {
    this.getOrThrow(loopId)
    this.deps.store.applyQueueOp(loopId, op)
    return this.publish(loopId)
  }

  /** Attaches the loop to the tab hosting its agent PTY, which is where the rail renders. */
  async bindTab(loopId: string, tab: { tabId: string; paneKey: string }): Promise<LoopSnapshot> {
    const loop = this.getOrThrow(loopId)
    const { runtime } = this.deps
    if (
      typeof runtime.getTerminalHandleForPaneKey !== 'function' ||
      typeof runtime.getTerminalPtyIdForHandle !== 'function'
    ) {
      fail('loop_runtime_unavailable', 'The runtime cannot resolve terminal panes')
    }
    const handle = runtime.getTerminalHandleForPaneKey(tab.paneKey)
    const ptyId = handle ? runtime.getTerminalPtyIdForHandle(handle) : null
    if (!ptyId || ptyId !== loop.ptyId || !tab.paneKey.startsWith(`${tab.tabId}:`)) {
      fail('loop_invalid_transition', `Pane ${tab.paneKey} does not host loop ${loopId}'s agent`)
    }
    this.deps.store.updateLoop(loopId, { tabId: tab.tabId, paneKey: tab.paneKey, detached: false })
    return this.publish(loopId)
  }

  /** Marks the loop as tab-less so its next fresh session starts in a background terminal. */
  async detach(loopId: string): Promise<LoopSnapshot> {
    this.getOpenOrThrow(loopId)
    this.deps.store.updateLoop(loopId, { detached: true })
    return this.publish(loopId)
  }

  /** Reveals the loop's background terminal in a tab and rebinds the rail to it. */
  async openTab(loopId: string): Promise<LoopSnapshot> {
    const loop = this.getOpenOrThrow(loopId)
    const { runtime } = this.deps
    if (
      typeof runtime.focusTerminal !== 'function' ||
      typeof runtime.getTerminalHandleForPaneKey !== 'function'
    ) {
      fail('loop_runtime_unavailable', 'The runtime cannot reveal a background terminal')
    }
    const handle = loop.paneKey ? runtime.getTerminalHandleForPaneKey(loop.paneKey) : null
    if (!loop.paneKey || !handle) {
      fail('loop_invalid_transition', `Loop ${loopId} has no live terminal to open`)
    }
    const focused = await runtime.focusTerminal(handle)
    return this.bindTab(loopId, { tabId: focused.tabId, paneKey: loop.paneKey })
  }

  /** Stops every driver without ending its loop, then closes the database. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.drivers.values()].map((driver) => driver.shutdown()))
    this.listeners.clear()
    this.deps.closeDatabase?.()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private getOrThrow(loopId: string): StoredLoop {
    this.start()
    return this.deps.store.getLoop(loopId) ?? fail('loop_not_found', `Loop ${loopId} not found`)
  }

  private getOpenOrThrow(loopId: string): StoredLoop {
    const loop = this.getOrThrow(loopId)
    return isEnded(loop)
      ? fail('loop_invalid_transition', `Loop ${loopId} has already ended`)
      : loop
  }

  private validateConfig(
    agent: LoopCreateInput['agent'],
    config: LoopConfig,
    checkTarget: LoopCheckTarget
  ): void {
    if (config.done.check) {
      const verdict = validateLoopCheckHost(checkTarget)
      if (!verdict.ok) {
        fail(verdict.code, verdict.message)
      }
    }
    const available = this.deps.isEvaluatorAvailable ?? isLoopEvaluatorAvailable
    if (config.done.evaluator && !available(agent)) {
      fail('loop_evaluator_unavailable', `No evaluator CLI is installed for ${agent}`)
    }
  }

  private driverFor(loopId: string): LoopDriver {
    let driver = this.drivers.get(loopId)
    if (!driver) {
      driver = new LoopDriver(loopId, {
        ...this.deps.driverDeps,
        store: this.deps.store,
        runtime: this.deps.runtime,
        notify: this.deps.notify,
        changed: (id) => {
          this.publish(id)
        }
      })
      this.drivers.set(loopId, driver)
    }
    return driver
  }

  private publish(loopId: string, warnings?: string[]): LoopSnapshot {
    const loop = this.getOrThrow(loopId)
    const snapshot = this.snapshot(loop, warnings)
    if (isEnded(loop)) {
      this.drivers.delete(loopId)
    }
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.warn('[loops] change listener failed:', error)
      }
    }
    return snapshot
  }

  private snapshot(loop: StoredLoop, warnings?: string[]): LoopSnapshot {
    const { store } = this.deps
    const iterations = store.listIterations(loop.id, { limit: LOOP_RECENT_ITERATIONS_LIMIT })
    const marker =
      loop.state === 'paused' &&
      (loop.pauseReason === 'agent-blocked' || loop.pauseReason === 'agent-decide')
        ? iterations.at(-1)?.markers.find((m) => m.kind === 'blocked' || m.kind === 'decide')
        : undefined
    const current = this.drivers.get(loop.id)?.current()
    return {
      id: loop.id,
      worktreeId: loop.worktreeId,
      name: loop.name,
      agent: loop.agent,
      preset: loop.preset,
      config: loop.config,
      state: loop.state,
      ...(loop.pauseReason ? { pauseReason: loop.pauseReason } : {}),
      ...(loop.pauseDetail ? { pauseDetail: loop.pauseDetail } : {}),
      ...(!loop.detached && loop.tabId && loop.paneKey
        ? { tab: { tabId: loop.tabId, paneKey: loop.paneKey } }
        : {}),
      iterationsCompleted: loop.iterationsCompleted,
      ...(current ? { currentIteration: current } : {}),
      detached: loop.detached,
      skippedTicks: loop.skippedTicks,
      activeMs: loop.activeMs,
      ...(loop.costUsd === null ? {} : { costUsd: loop.costUsd }),
      ...(loop.nextIterationAt === null ? {} : { nextIterationAt: loop.nextIterationAt }),
      ...(marker && marker.kind !== 'done'
        ? { pendingQuestion: { kind: marker.kind, text: marker.text ?? '' } }
        : {}),
      recentIterations: iterations.map((row) => ({
        n: row.n,
        attempt: row.attempt,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        endReason: row.endReason,
        checkPass: row.check ? row.check.pass : null,
        evaluatorVerdict: row.evaluator?.verdict ?? null,
        added: row.diff?.added ?? null,
        removed: row.diff?.removed ?? null,
        costUsd: row.costUsd
      })),
      ...(warnings && warnings.length > 0 ? { warnings } : {})
    }
  }
}
