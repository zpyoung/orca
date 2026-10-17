import type {
  CheckOutcome,
  DiffStats,
  EvaluatorVerdict,
  LoopConfig,
  TreeSnapshot,
  UsageTotals
} from '../../shared/fork-loops/loop-types'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalWait
} from '../../shared/runtime-terminal-contracts'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentRelaunchRuntime } from './agent-session-relaunch'
import type { InputAttribution } from './input-attribution'
import type { IterationObserver } from './iteration-observer'
import type { LoopCheckTarget } from './loop-check'
import type { StoredLoop } from './loop-database'
import type { LoopEvaluationArgs } from './loop-evaluator'
import type { LoopWorkspaceTarget } from './loop-notes-file'
import type { LoopNotifyEvent } from './loop-notify'
import type { LoopStore } from './loop-store'

export type LoopTargets = {
  workspace: LoopWorkspaceTarget
  check: LoopCheckTarget
  executionHostId: string
}

/** The runtime surface a driver uses; every member is optional so partial doubles stay valid. */
export type LoopDriverRuntime = AgentRelaunchRuntime & {
  createTerminal?(
    worktreeSelector: string,
    opts: {
      startupAgent: TuiAgent
      title?: string
      agentArgs?: string | null
      launchPreferences?: AgentLaunchPreferences
    }
  ): Promise<RuntimeTerminalCreate>
  sendTerminalAgentPrompt?(
    handle: string,
    prompt: string,
    options: {
      inputKind: 'driving'
      acceptQueued?: boolean
      requestId?: string
      observationTimeoutMs?: number
      beforeWrite?: (ptyId: string) => void | Promise<void>
      afterWrite?: (ptyId: string) => void | Promise<void>
    }
  ): Promise<unknown>
  waitForTerminal?(
    handle: string,
    options?: {
      condition?: 'exit' | 'tui-idle'
      timeoutMs?: number
      signal?: AbortSignal
      launchReadiness?: boolean
    }
  ): Promise<RuntimeTerminalWait>
  getTerminalHandleForPaneKey?(paneKey: string): string | null
  getTerminalPtyIdForHandle?(handle: string): string | null
  getPtyLivenessVerdict?(ptyId: string): PtyLivenessVerdict | null
  readTerminal?(handle: string, options?: { limit?: number }): Promise<{ tail: string[] }>
  getAgentStatusRowsForPane?(paneKey: string): readonly { state: string }[]
}

/**
 * Evidence gatherers; each reports failure as data so the driver's decision stays total. A null
 * diff means the change could not be measured.
 */
export type LoopEvidenceTools = {
  snapshotTree(target: LoopWorkspaceTarget): Promise<TreeSnapshot | null>
  diffTrees(
    before: TreeSnapshot,
    after: TreeSnapshot,
    target: LoopWorkspaceTarget
  ): Promise<DiffStats | null>
  runCheck(config: LoopConfig, target: LoopCheckTarget, signal?: AbortSignal): Promise<CheckOutcome>
  evaluate(args: LoopEvaluationArgs): Promise<EvaluatorVerdict>
  readUsage(paneKey: string, worktreeId: string, agent: TuiAgent): Promise<UsageTotals | null>
  readUsageLimit(agent: TuiAgent): { provider: 'claude' | 'codex'; resetsAt: number | null } | null
}

export type LoopDriverDeps = {
  store: LoopStore
  runtime: LoopDriverRuntime
  observer: Pick<IterationObserver, 'observeIteration'>
  inputAttribution: Pick<InputAttribution, 'noteLoopWrite' | 'userIdleFor'>
  tools: LoopEvidenceTools
  targets(worktreeId: string): Promise<LoopTargets>
  changed(loopId: string): void
  notify(loop: StoredLoop, event: LoopNotifyEvent, detail?: string): void
  now?(): number
  sleep?(ms: number, signal: AbortSignal): Promise<void>
  pollMs?: number
}

export type PaneRef = { handle: string; ptyId: string }

export type IterationContext = {
  n: number
  attempt: number
  startedAt: number
  loop: StoredLoop
  targets: LoopTargets | null
  before: TreeSnapshot | null
  usageBefore: UsageTotals | null
  error: string | null
}
