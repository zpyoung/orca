import type { NeedsYouReason } from '../../shared/fork-loops/loop-types'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import { LOOP_USER_IDLE_MS, type InputAttribution } from './input-attribution'

export const ITERATION_NO_BUSY_EDGE_SETTLE_MS = 120_000
export const ITERATION_POLL_MS = 1000

export type IterationSettlement =
  | { kind: 'settled'; settledAt: number; lastAssistantMessage?: string }
  | { kind: 'crashed'; exitCode: number | null }
  | { kind: 'unverifiable' }
  | { kind: 'aborted' }

/** The slice of an agent-hooks status row the observer reads; the hook server's rows satisfy it. */
export type IterationHookRow = {
  state: AgentStatusState
  receivedAt: number
  turnStartedAt?: number
  interactivePrompt?: string
  lastAssistantMessage?: string
  interrupted?: boolean
  sessionBoundary?: boolean
  providerSessionOnly?: boolean
}

export type IterationHookSource = {
  getStatusSnapshotForPane(paneKey: string): readonly IterationHookRow[]
  subscribeStatusChanges?(listener: (statuses: readonly { paneKey: string }[]) => void): () => void
}

export type IterationRuntime = {
  waitForTerminal(
    handle: string,
    options?: { condition?: 'exit' | 'tui-idle'; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RuntimeTerminalWait>
  getPtyLivenessVerdict?(ptyId: string): PtyLivenessVerdict | null
}

export type IterationObserverDeps = {
  runtime: IterationRuntime
  hookSource?: IterationHookSource
  inputAttribution: Pick<InputAttribution, 'userInputSince' | 'userIdleFor'>
  now?: () => number
  pollMs?: number
  noBusyEdgeSettleMs?: number
  userIdleMs?: number
}

export type ObserveIterationArgs = {
  handle: string
  paneKey: string
  ptyId: string
  sentAt: number
  signal: AbortSignal
  onNeedsYou(reason: NeedsYouReason): void
  onResumed(): void
}

export type IterationObserver = {
  /**
   * Resolves when the iteration prompt written at `sentAt` has been worked on and the agent is idle
   * again. Hook rows are the evidence when the pane has any; otherwise `tui-idle` polling is.
   * Losing contact with the host resolves `unverifiable`, never `crashed`.
   */
  observeIteration(args: ObserveIterationArgs): Promise<IterationSettlement>
}

export function createIterationObserver(deps: IterationObserverDeps): IterationObserver {
  return { observeIteration: (args) => observeIteration(deps, args) }
}

type IterationWake = {
  wait(ms: number): Promise<void>
  notify(): void
  dispose(): void
}

function createIterationWake(signal: AbortSignal): IterationWake {
  let release: (() => void) | null = null
  let notified = false
  const onAbort = (): void => release?.()
  signal.addEventListener('abort', onAbort)
  return {
    wait(ms) {
      if (notified || signal.aborted) {
        notified = false
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => release?.(), ms)
        release = () => {
          clearTimeout(timer)
          release = null
          resolve()
        }
      })
    },
    notify() {
      if (release) {
        release()
      } else {
        notified = true
      }
    },
    dispose() {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function isIdleState(row: IterationHookRow): boolean {
  return row.state === 'waiting' || row.state === 'done'
}

function latestMainRow(rows: readonly IterationHookRow[]): IterationHookRow | null {
  let latest: IterationHookRow | null = null
  for (const row of rows) {
    if (!row.providerSessionOnly && (latest === null || row.receivedAt >= latest.receivedAt)) {
      latest = row
    }
  }
  return latest
}

async function observeIteration(
  deps: IterationObserverDeps,
  args: ObserveIterationArgs
): Promise<IterationSettlement> {
  const { runtime, hookSource, inputAttribution } = deps
  const { signal, sentAt } = args
  const now = deps.now ?? Date.now
  const pollMs = deps.pollMs ?? ITERATION_POLL_MS
  const noBusyEdgeSettleMs = deps.noBusyEdgeSettleMs ?? ITERATION_NO_BUSY_EDGE_SETTLE_MS
  const userIdleMs = deps.userIdleMs ?? LOOP_USER_IDLE_MS

  let busyEdgeAt: number | null = null
  let needsYouSince: number | null = null
  let pausedMs = 0
  let interruptedAt: number | null = null

  const wake = createIterationWake(signal)
  const unsubscribe =
    hookSource && typeof hookSource.subscribeStatusChanges === 'function'
      ? hookSource.subscribeStatusChanges((statuses) => {
          if (statuses.some((status) => status.paneKey === args.paneKey)) {
            wake.notify()
          }
        })
      : null

  const markBusy = (at: number): void => {
    busyEdgeAt ??= at
  }

  const enterNeedsYou = (reason: NeedsYouReason): void => {
    if (needsYouSince === null) {
      needsYouSince = now()
      args.onNeedsYou(reason)
    }
  }

  const resume = (): void => {
    if (needsYouSince !== null) {
      pausedMs += now() - needsYouSince
      needsYouSince = null
      args.onResumed()
    }
  }

  const settleUnlessUserActive = (lastAssistantMessage?: string): IterationSettlement | null => {
    const at = now()
    if (interruptedAt !== null && at - interruptedAt < userIdleMs) {
      return null
    }
    if (
      inputAttribution.userInputSince(args.ptyId, sentAt) &&
      !inputAttribution.userIdleFor(args.ptyId, userIdleMs)
    ) {
      return null
    }
    return {
      kind: 'settled',
      settledAt: at,
      ...(lastAssistantMessage ? { lastAssistantMessage } : {})
    }
  }

  const noBusyEdgeSettlement = (): IterationSettlement | null => {
    if (busyEdgeAt !== null || needsYouSince !== null) {
      return null
    }
    return now() - sentAt - pausedMs >= noBusyEdgeSettleMs ? settleUnlessUserActive() : null
  }

  const probeProcess = async (): Promise<IterationSettlement | null> => {
    if (typeof runtime.getPtyLivenessVerdict !== 'function') {
      return null
    }
    const verdict = runtime.getPtyLivenessVerdict(args.ptyId)
    if (verdict?.status === 'unverifiable') {
      return { kind: 'unverifiable' }
    }
    if (verdict?.status !== 'exited') {
      return null
    }
    const exit = await runtime
      .waitForTerminal(args.handle, { condition: 'exit', timeoutMs: pollMs, signal })
      .catch(() => null)
    return { kind: 'crashed', exitCode: exit?.exitCode ?? null }
  }

  const evaluateHookRow = (row: IterationHookRow): IterationSettlement | null => {
    if ((row.state === 'done' && row.sessionBoundary === true) || row.receivedAt < sentAt) {
      return null
    }
    if (row.turnStartedAt !== undefined && row.turnStartedAt >= sentAt) {
      markBusy(row.turnStartedAt)
    }
    if (row.state === 'blocked' || row.interactivePrompt) {
      markBusy(row.receivedAt)
      enterNeedsYou(row.interactivePrompt ? 'interactive-prompt' : 'blocked-state')
      return null
    }
    resume()
    if (row.state === 'working') {
      markBusy(row.receivedAt)
      return null
    }
    if (row.state === 'done' && row.interrupted === true) {
      markBusy(row.receivedAt)
      interruptedAt = Math.max(interruptedAt ?? row.receivedAt, row.receivedAt)
    }
    if (isIdleState(row) && busyEdgeAt !== null && row.receivedAt >= busyEdgeAt) {
      return settleUnlessUserActive(row.lastAssistantMessage)
    }
    return null
  }

  const evaluateTuiIdle = async (): Promise<IterationSettlement | null> => {
    let result: RuntimeTerminalWait | null
    try {
      result = await runtime.waitForTerminal(args.handle, {
        condition: 'tui-idle',
        timeoutMs: pollMs,
        signal
      })
    } catch (error) {
      if (signal.aborted) {
        return { kind: 'aborted' }
      }
      if (error instanceof Error && error.message === 'timeout') {
        result = null
      } else {
        return { kind: 'unverifiable' }
      }
    }
    if (result?.status === 'exited') {
      return { kind: 'crashed', exitCode: result.exitCode }
    }
    if (result?.blockedReason) {
      enterNeedsYou(result.blockedReason)
      return null
    }
    resume()
    if (result === null || !result.satisfied) {
      markBusy(now())
      return null
    }
    return busyEdgeAt === null ? null : settleUnlessUserActive()
  }

  try {
    while (true) {
      if (signal.aborted) {
        return { kind: 'aborted' }
      }
      const tickStartedAt = now()
      let settlement: IterationSettlement | null
      try {
        settlement = await probeProcess()
        if (settlement === null) {
          const row = hookSource
            ? latestMainRow(hookSource.getStatusSnapshotForPane(args.paneKey))
            : null
          settlement = row ? evaluateHookRow(row) : await evaluateTuiIdle()
        }
      } catch {
        return signal.aborted ? { kind: 'aborted' } : { kind: 'unverifiable' }
      }
      settlement ??= noBusyEdgeSettlement()
      if (settlement) {
        return settlement
      }
      await wake.wait(Math.max(0, pollMs - (now() - tickStartedAt)))
    }
  } finally {
    unsubscribe?.()
    wake.dispose()
  }
}
