import { randomUUID } from 'node:crypto'
import type { IterationPhase, NeedsYouReason } from '../../shared/fork-loops/loop-types'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import { isAgentPromptStalledError } from '../runtime/agent-prompt-submission-verification'
import {
  LoopRuntimeUnavailableError,
  relaunchAgentInNewTab,
  type AgentRelaunchRuntime,
  type RelaunchedAgentTab
} from './agent-session-relaunch'
import { LOOP_USER_IDLE_MS, type InputAttribution } from './input-attribution'
import type { IterationObserver, IterationSettlement } from './iteration-observer'
import type { StoredLoop } from './loop-database'
import type { LoopStore } from './loop-store'
import type { LoopDriverDeps, LoopDriverRuntime, PaneRef } from './loop-driver-types'

const AGENT_READY_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 1000
const GONE_HANDLE_ERRORS: ReadonlySet<string> = new Set([
  'terminal_handle_stale',
  'terminal_not_found',
  'tab_not_found'
])

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

/** The live handle and pty behind a pane key, or null when the pane is gone or unresolvable. */
export function resolvePane(runtime: LoopDriverRuntime, paneKey: string | null): PaneRef | null {
  if (!paneKey || typeof runtime.getTerminalHandleForPaneKey !== 'function') {
    return null
  }
  try {
    const handle = runtime.getTerminalHandleForPaneKey(paneKey)
    if (!handle) {
      return null
    }
    const ptyId =
      typeof runtime.getTerminalPtyIdForHandle === 'function'
        ? runtime.getTerminalPtyIdForHandle(handle)
        : null
    if (ptyId) {
      return { handle, ptyId }
    }
    // getTerminalPtyIdForHandle answers only for headless pty handles, never a renderer tab's pane
    if (typeof runtime.resolveTerminalPane !== 'function') {
      return null
    }
    const pane = runtime.resolveTerminalPane(paneKey)
    return pane.ptyId && pane.connected !== false
      ? { handle: pane.handle, ptyId: pane.ptyId }
      : null
  } catch {
    return null
  }
}

/** The handle still naming the loop's last pane, live or not, so a relaunch can close its tab. */
function lastPaneHandle(runtime: LoopDriverRuntime, paneKey: string | null): string | null {
  if (!paneKey || typeof runtime.getTerminalHandleForPaneKey !== 'function') {
    return null
  }
  try {
    return runtime.getTerminalHandleForPaneKey(paneKey)
  } catch {
    return null
  }
}

/** The iteration number and attempt to record next; a retry or an interrupted run reuses its number. */
export function nextIterationSlot(
  store: Pick<LoopStore, 'listIterations'>,
  loopId: string,
  loop: Pick<StoredLoop, 'iterationsCompleted'>,
  isRetry: boolean
): { n: number; attempt: number; reRun: boolean } {
  const lastRow = store.listIterations(loopId, { limit: 1 }).at(-1) ?? null
  const reRun = lastRow?.endReason === 'interrupted'
  const n =
    isRetry || reRun ? (lastRow?.n ?? loop.iterationsCompleted + 1) : loop.iterationsCompleted + 1
  // a resumed loop re-enters an iteration number whose crashed attempts must stay on record
  const attempt = store
    .listIterations(loopId)
    .filter((row) => row.n === n)
    .reduce((next, row) => Math.max(next, row.attempt + 1), 0)
  return { n, attempt, reRun }
}

/**
 * Whether the loop's host can still vouch for its pty. Only a positive `unverifiable` verdict
 * counts: an `exited` pty needs no hold because the next iteration relaunches the agent.
 */
export function loopConnection(
  runtime: LoopDriverRuntime,
  loop: Pick<StoredLoop, 'paneKey' | 'ptyId'>
): 'live' | 'unverifiable' {
  const ptyId = resolvePane(runtime, loop.paneKey)?.ptyId ?? loop.ptyId
  if (!ptyId || typeof runtime.getPtyLivenessVerdict !== 'function') {
    return 'live'
  }
  try {
    return runtime.getPtyLivenessVerdict(ptyId)?.status === 'unverifiable' ? 'unverifiable' : 'live'
  } catch {
    return 'live'
  }
}

/** Whether the user typed into the loop's pane within the idle window. */
export function isUserTyping(
  deps: Pick<LoopDriverDeps, 'runtime' | 'inputAttribution'>,
  paneKey: string | null
): boolean {
  const pane = resolvePane(deps.runtime, paneKey)
  return pane !== null && !deps.inputAttribution.userIdleFor(pane.ptyId, LOOP_USER_IDLE_MS)
}

/** Whether the agent in the loop's pane is mid-turn. */
export function isAgentBusy(runtime: LoopDriverRuntime, paneKey: string | null): boolean {
  const read = runtime.getAgentStatusRowsForPane
  return paneKey !== null && typeof read === 'function'
    ? read.call(runtime, paneKey).some((row) => row.state === 'working')
    : false
}

/** Polls until neither the user nor the agent is active; false when the signal or `stopped` aborts. */
export async function waitForInputIdle(
  deps: Pick<LoopDriverDeps, 'runtime' | 'inputAttribution' | 'sleep' | 'pollMs'>,
  paneKey: string | null,
  signal: AbortSignal,
  stopped: () => boolean
): Promise<boolean> {
  const active = (): boolean => isUserTyping(deps, paneKey) || isAgentBusy(deps.runtime, paneKey)
  while (active() && !signal.aborted && !stopped()) {
    await (deps.sleep ?? abortableSleep)(deps.pollMs ?? DEFAULT_POLL_MS, signal)
  }
  return !signal.aborted && !stopped()
}

/** Launches through `createTerminal` with no `rendererBacked`, which the runtime builds as a background terminal. */
function backgroundAgentLauncher(
  runtime: LoopDriverRuntime
): AgentRelaunchRuntime['launchAgentTerminal'] {
  if (!('createTerminal' in runtime) || typeof runtime.createTerminal !== 'function') {
    return undefined
  }
  const create = runtime.createTerminal.bind(runtime)
  return (worktreeSelector, opts) => {
    const { model, optionValues, agentArgs } = opts.launchOverrides ?? {}
    return create(worktreeSelector, {
      startupAgent: opts.agent,
      ...(opts.title ? { title: opts.title } : {}),
      ...(agentArgs !== undefined ? { agentArgs } : {}),
      ...(model !== undefined || optionValues !== undefined
        ? {
            launchPreferences: {
              ...(model !== undefined ? { model } : {}),
              ...(optionValues !== undefined ? { optionValues } : {})
            }
          }
        : {})
    })
  }
}

/**
 * Starts a fresh agent for the loop and closes its previous tab: `previous` when live, else the tab
 * of the loop's last pane if it is still open. A close that fails after the new tab launched is
 * reported in `closeError` instead of failing, so the loop still binds the new tab.
 */
export async function relaunchLoopAgent(
  runtime: LoopDriverRuntime,
  loop: Pick<
    StoredLoop,
    'worktreeId' | 'detached' | 'agent' | 'name' | 'launchOverrides' | 'paneKey'
  >,
  previous: PaneRef | null
): Promise<RelaunchedAgentTab & { closeError: string | null }> {
  let closeError: string | null = null
  const close = runtime.closeTerminalTab?.bind(runtime)
  const wrapped: AgentRelaunchRuntime = {
    launchAgentTerminal: loop.detached
      ? backgroundAgentLauncher(runtime)
      : runtime.launchAgentTerminal?.bind(runtime),
    closeTerminalTab: close
      ? async (handle) => {
          try {
            return await close(handle)
          } catch (error) {
            if (GONE_HANDLE_ERRORS.has(errorMessage(error))) {
              throw error
            }
            closeError = `previous tab did not close: ${errorMessage(error)}`
            return { handle, tabId: '', ptyKilled: false }
          }
        }
      : undefined
  }
  const launched = await relaunchAgentInNewTab(wrapped, {
    worktreeId: loop.worktreeId,
    previousHandle: previous?.handle ?? lastPaneHandle(runtime, loop.paneKey),
    agent: loop.agent,
    title: loop.name,
    ...(loop.launchOverrides ? { launchOverrides: loop.launchOverrides } : {})
  })
  return { ...launched, closeError }
}

export type AgentReadyArgs = {
  runtime: LoopDriverRuntime
  handle: string
  ptyId?: string
  signal: AbortSignal
  pollMs?: number
  now(): number
  onBlocked(reason: NeedsYouReason): void
  onUnblocked(): void
}

export type AgentReadiness = 'ready' | 'crashed' | 'aborted' | 'unverifiable'

/** `crashed` only when the host positively reports the PTY exited; lost contact stays `unverifiable`. */
function readinessFailure(args: AgentReadyArgs): 'crashed' | 'unverifiable' {
  const read = args.runtime.getPtyLivenessVerdict
  if (!args.ptyId || typeof read !== 'function') {
    return 'crashed'
  }
  return read.call(args.runtime, args.ptyId)?.status === 'unverifiable' ? 'unverifiable' : 'crashed'
}

/**
 * Waits for a just-launched agent's composer; a blocking dialog hands control to the user. A
 * failure is `unverifiable` when the PTY's host cannot confirm the agent is gone.
 */
export async function awaitAgentReady(args: AgentReadyArgs): Promise<AgentReadiness> {
  const { runtime, signal } = args
  if (typeof runtime.waitForTerminal !== 'function') {
    return 'ready'
  }
  const deadline = args.now() + AGENT_READY_TIMEOUT_MS
  let blocked = false
  while (args.now() < deadline || blocked) {
    if (signal.aborted) {
      return 'aborted'
    }
    let wait: RuntimeTerminalWait
    try {
      wait = await runtime.waitForTerminal(args.handle, {
        condition: 'tui-idle',
        timeoutMs: args.pollMs ?? DEFAULT_POLL_MS,
        signal,
        launchReadiness: true
      })
    } catch (error) {
      if (errorMessage(error) !== 'timeout') {
        return signal.aborted ? 'aborted' : readinessFailure(args)
      }
      continue
    }
    if (wait.status === 'exited') {
      return 'crashed'
    }
    if (wait.satisfied) {
      if (blocked) {
        args.onUnblocked()
      }
      return 'ready'
    }
    if (wait.blockedReason && !blocked) {
      blocked = true
      args.onBlocked(wait.blockedReason)
    }
  }
  return readinessFailure(args)
}

export type LaunchedAgentArgs = Omit<AgentReadyArgs, 'handle' | 'ptyId'> & {
  pane: PaneRef
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  onPhase(phase: IterationPhase): void
  onHoldStart(): void
  onHoldEnd(): void
}

/** Awaits readiness and holds, like an unverifiable settlement, while a launch cannot be confirmed. */
export async function awaitLaunchedAgent(
  args: LaunchedAgentArgs
): Promise<Exclude<AgentReadiness, 'unverifiable'>> {
  const { pane, sleep, onPhase, onHoldStart, onHoldEnd, ...ready } = args
  for (;;) {
    const readiness = await awaitAgentReady({ ...ready, handle: pane.handle, ptyId: pane.ptyId })
    if (readiness !== 'unverifiable') {
      return readiness
    }
    onHoldStart()
    const held = await holdUntilPaneLive({
      runtime: args.runtime,
      pane,
      signal: args.signal,
      pollMs: args.pollMs,
      sleep
    })
    onHoldEnd()
    if (held !== 'live') {
      return held === 'exited' ? 'crashed' : 'aborted'
    }
    onPhase('sending')
  }
}

/** The user typed into the pane after the idle check, so the prompt was not written. */
export class LoopUserInputDuringSendError extends Error {
  constructor() {
    super('the user typed before the prompt could be written')
    this.name = 'LoopUserInputDuringSendError'
  }
}

/**
 * Delivers one iteration prompt, recording the write window so the user's typing stays distinct.
 * Throws `LoopUserInputDuringSendError`, before any byte is written, when the user typed at or
 * after `userIdleAt`.
 */
export async function sendAgentPrompt(
  runtime: LoopDriverRuntime,
  inputAttribution: Pick<InputAttribution, 'noteLoopWrite'> &
    Partial<Pick<InputAttribution, 'userInputSince'>>,
  pane: PaneRef,
  prompt: string,
  now: () => number,
  userIdleAt: number
): Promise<void> {
  if (typeof runtime.sendTerminalAgentPrompt !== 'function') {
    throw new LoopRuntimeUnavailableError('the runtime cannot send an agent prompt')
  }
  const noteWrite = (ptyId: string): void => inputAttribution.noteLoopWrite(ptyId, now())
  // the runtime calls beforeWrite again before the submit key; vetoing then would strand the paste
  let pasteWritten = false
  const guardedBeforeWrite = (ptyId: string): void => {
    if (!pasteWritten && inputAttribution.userInputSince?.(ptyId, userIdleAt)) {
      throw new LoopUserInputDuringSendError()
    }
    pasteWritten = true
    noteWrite(ptyId)
  }
  try {
    await runtime.sendTerminalAgentPrompt(pane.handle, prompt, {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: randomUUID(),
      observationTimeoutMs: 0,
      beforeWrite: guardedBeforeWrite,
      afterWrite: noteWrite
    })
  } catch (error) {
    if (!isAgentPromptStalledError(error)) {
      throw error
    }
  }
}

/** Interrupts the agent's in-flight turn; the write is recorded so it is not read as user input. */
export async function interruptAgentTurn(
  runtime: LoopDriverRuntime,
  inputAttribution: Pick<InputAttribution, 'noteLoopWrite'>,
  handle: string,
  now: () => number
): Promise<void> {
  if (typeof runtime.sendTerminal !== 'function') {
    throw new LoopRuntimeUnavailableError('the runtime cannot interrupt an agent turn')
  }
  const noteWrite = (ptyId: string): void => inputAttribution.noteLoopWrite(ptyId, now())
  await runtime.sendTerminal(
    handle,
    { interrupt: true },
    { inputKind: 'driving', beforeWrite: noteWrite, afterWrite: noteWrite }
  )
}

/** Best-effort stop-now interrupt; a failure comes back as text for the iteration record. */
export async function interruptForStop(
  runtime: LoopDriverRuntime,
  inputAttribution: Pick<InputAttribution, 'noteLoopWrite'>,
  handle: string,
  now: () => number
): Promise<string | null> {
  try {
    await interruptAgentTurn(runtime, inputAttribution, handle, now)
    return null
  } catch (error) {
    return `agent turn was not interrupted: ${errorMessage(error)}`
  }
}

export type ObserveArgs = {
  runtime: LoopDriverRuntime
  observer: Pick<IterationObserver, 'observeIteration'>
  pane: PaneRef
  paneKey(): string
  sentAt: number
  signal: AbortSignal
  pollMs?: number
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  onNeedsYou(reason: NeedsYouReason): void
  onResumed(): void
  onPhase(phase: IterationPhase): void
  onHoldStart(): void
  onHoldEnd(): void
}

export type HoldArgs = {
  runtime: LoopDriverRuntime
  pane: PaneRef
  signal: AbortSignal
  pollMs?: number
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

/** Polls PTY liveness until the pane is `live`, positively `exited`, or the signal aborts. */
export async function holdUntilPaneLive(args: HoldArgs): Promise<'live' | 'exited' | 'aborted'> {
  const { runtime, pane, signal } = args
  const sleep = args.sleep ?? abortableSleep
  let verdict: PtyLivenessVerdict | null = null
  while (!signal.aborted && verdict?.status !== 'live') {
    await sleep(args.pollMs ?? DEFAULT_POLL_MS, signal)
    verdict =
      typeof runtime.getPtyLivenessVerdict === 'function'
        ? runtime.getPtyLivenessVerdict(pane.ptyId)
        : { status: 'live', ptyIds: [pane.ptyId] }
    if (verdict?.status === 'exited') {
      return 'exited'
    }
  }
  return signal.aborted ? 'aborted' : 'live'
}

/** Observes until settled, holding through a lost connection instead of counting a crash. */
export async function observeUntilSettled(args: ObserveArgs): Promise<IterationSettlement> {
  const { runtime, observer, pane, signal } = args
  for (;;) {
    const settlement = await observer.observeIteration({
      handle: pane.handle,
      paneKey: args.paneKey(),
      ptyId: pane.ptyId,
      sentAt: args.sentAt,
      signal,
      onNeedsYou: args.onNeedsYou,
      onResumed: args.onResumed
    })
    if (settlement.kind !== 'unverifiable') {
      return settlement
    }
    args.onHoldStart()
    const held = await holdUntilPaneLive({
      runtime,
      pane,
      signal,
      pollMs: args.pollMs,
      sleep: args.sleep
    })
    args.onHoldEnd()
    if (held === 'exited') {
      return { kind: 'crashed', exitCode: null }
    }
    if (held === 'aborted') {
      return { kind: 'aborted' }
    }
    args.onPhase('working')
  }
}
