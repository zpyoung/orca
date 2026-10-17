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
import type { InputAttribution } from './input-attribution'
import type { IterationObserver, IterationSettlement } from './iteration-observer'
import type { StoredLoop } from './loop-database'
import type { LoopDriverRuntime, PaneRef } from './loop-driver-types'

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
  if (
    !paneKey ||
    typeof runtime.getTerminalHandleForPaneKey !== 'function' ||
    typeof runtime.getTerminalPtyIdForHandle !== 'function'
  ) {
    return null
  }
  try {
    const handle = runtime.getTerminalHandleForPaneKey(paneKey)
    const ptyId = handle ? runtime.getTerminalPtyIdForHandle(handle) : null
    return handle && ptyId ? { handle, ptyId } : null
  } catch {
    return null
  }
}

/**
 * Starts a fresh agent for the loop and closes `previous`. A close that fails after the new tab
 * launched is reported in `closeError` instead of failing, so the loop still binds the new tab.
 */
export async function relaunchLoopAgent(
  runtime: LoopDriverRuntime,
  loop: StoredLoop,
  previous: PaneRef | null
): Promise<RelaunchedAgentTab & { closeError: string | null }> {
  let closeError: string | null = null
  const close = runtime.closeTerminalTab?.bind(runtime)
  const wrapped: AgentRelaunchRuntime = {
    launchAgentTerminal: runtime.launchAgentTerminal?.bind(runtime),
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
    previousHandle: previous?.handle ?? null,
    agent: loop.agent,
    title: loop.name,
    ...(loop.launchOverrides ? { launchOverrides: loop.launchOverrides } : {})
  })
  return { ...launched, closeError }
}

export type AgentReadyArgs = {
  runtime: LoopDriverRuntime
  handle: string
  signal: AbortSignal
  pollMs?: number
  now(): number
  onBlocked(reason: NeedsYouReason): void
  onUnblocked(): void
}

/** Waits for a just-launched agent's composer; a blocking dialog hands control to the user. */
export async function awaitAgentReady(
  args: AgentReadyArgs
): Promise<'ready' | 'crashed' | 'aborted'> {
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
        return signal.aborted ? 'aborted' : 'crashed'
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
  return 'crashed'
}

/** Delivers one iteration prompt, recording the write window so the user's typing stays distinct. */
export async function sendAgentPrompt(
  runtime: LoopDriverRuntime,
  inputAttribution: Pick<InputAttribution, 'noteLoopWrite'>,
  pane: PaneRef,
  prompt: string,
  now: () => number
): Promise<void> {
  if (typeof runtime.sendTerminalAgentPrompt !== 'function') {
    throw new LoopRuntimeUnavailableError('the runtime cannot send an agent prompt')
  }
  const noteWrite = (ptyId: string): void => inputAttribution.noteLoopWrite(ptyId, now())
  try {
    await runtime.sendTerminalAgentPrompt(pane.handle, prompt, {
      inputKind: 'driving',
      acceptQueued: true,
      requestId: randomUUID(),
      observationTimeoutMs: 0,
      beforeWrite: noteWrite,
      afterWrite: noteWrite
    })
  } catch (error) {
    if (!isAgentPromptStalledError(error)) {
      throw error
    }
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
}

/** Observes until settled, holding through a lost connection instead of counting a crash. */
export async function observeUntilSettled(args: ObserveArgs): Promise<IterationSettlement> {
  const { runtime, observer, pane, signal } = args
  const sleep = args.sleep ?? abortableSleep
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
    args.onPhase('waiting')
    let verdict: PtyLivenessVerdict | null = null
    while (!signal.aborted && verdict?.status !== 'live') {
      await sleep(args.pollMs ?? DEFAULT_POLL_MS, signal)
      verdict =
        typeof runtime.getPtyLivenessVerdict === 'function'
          ? runtime.getPtyLivenessVerdict(pane.ptyId)
          : { status: 'live', ptyIds: [pane.ptyId] }
      if (verdict?.status === 'exited') {
        return { kind: 'crashed', exitCode: null }
      }
    }
    if (signal.aborted) {
      return { kind: 'aborted' }
    }
    args.onPhase('working')
  }
}
