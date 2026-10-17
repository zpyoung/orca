import type { AgentLaunchOverrides } from '../../shared/fork-automation-launch-settings/agent-launch-overrides'
import type { LoopErrorCode } from '../../shared/fork-loops/loop-types'
import type {
  RuntimeTerminalClose,
  RuntimeTerminalCreate
} from '../../shared/runtime-terminal-contracts'
import type { TuiAgent } from '../../shared/tui-agent'

const GONE_HANDLE_ERRORS: ReadonlySet<string> = new Set([
  'terminal_handle_stale',
  'terminal_not_found',
  'tab_not_found'
])

export class LoopRuntimeUnavailableError extends Error {
  readonly code: LoopErrorCode = 'loop_runtime_unavailable'

  constructor(detail: string) {
    super(`loop_runtime_unavailable: ${detail}`)
    this.name = 'LoopRuntimeUnavailableError'
  }
}

export type AgentRelaunchRuntime = {
  launchAgentTerminal?(
    worktreeSelector: string,
    opts: {
      agent: TuiAgent
      prompt: string
      title?: string
      launchOverrides?: AgentLaunchOverrides
    }
  ): Promise<RuntimeTerminalCreate>
  closeTerminalTab?(handle: string): Promise<RuntimeTerminalClose>
}

export type RelaunchedAgentTab = {
  handle: string
  tabId: string
  paneKey: string
  ptyId: string
}

function isGoneHandle(error: unknown): boolean {
  return error instanceof Error && GONE_HANDLE_ERRORS.has(error.message)
}

async function closeTab(runtime: AgentRelaunchRuntime, handle: string): Promise<void> {
  if (!('closeTerminalTab' in runtime) || typeof runtime.closeTerminalTab !== 'function') {
    return
  }
  try {
    await runtime.closeTerminalTab(handle)
  } catch (error) {
    if (!isGoneHandle(error)) {
      throw error
    }
  }
}

/**
 * Starts a fresh agent in a new tab of the worktree, then closes the loop's previous tab. The launch
 * comes first so the worktree never drops to zero tabs mid-swap, and a failed launch leaves the
 * previous tab untouched. The close is a lifecycle close, so it does not trip the renderer's loop
 * close guard. A previous tab that is already gone is not an error. The caller rebinds the loop to
 * the returned tab.
 *
 * @throws LoopRuntimeUnavailableError when the runtime cannot launch an agent terminal.
 */
export async function relaunchAgentInNewTab(
  runtime: AgentRelaunchRuntime,
  args: {
    worktreeId: string
    previousHandle: string | null
    agent: TuiAgent
    title: string
    launchOverrides?: AgentLaunchOverrides
  }
): Promise<RelaunchedAgentTab> {
  if (!('launchAgentTerminal' in runtime) || typeof runtime.launchAgentTerminal !== 'function') {
    throw new LoopRuntimeUnavailableError('the runtime cannot launch an agent terminal')
  }
  const launched = await runtime.launchAgentTerminal(`id:${args.worktreeId}`, {
    agent: args.agent,
    prompt: '',
    title: args.title,
    ...(args.launchOverrides ? { launchOverrides: args.launchOverrides } : {})
  })
  const { tabId, paneKey, ptyId } = launched
  if (!tabId || !paneKey || !ptyId) {
    await closeTab(runtime, launched.handle).catch(() => {})
    throw new Error('agent launch did not report its tab identity')
  }
  if (args.previousHandle) {
    await closeTab(runtime, args.previousHandle)
  }
  return { handle: launched.handle, tabId, paneKey, ptyId }
}
