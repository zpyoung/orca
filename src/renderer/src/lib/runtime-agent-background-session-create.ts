import type { AgentLaunchOverrides } from '../../../shared/agent-launch-overrides'
import type { TuiAgent } from '../../../shared/types'
import type { AgentStartupPlan } from './tui-agent-startup'
import { createRuntimeAgentBackgroundTerminal } from './runtime-agent-background-create'
import { toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'

/** Create one background agent session on a paired runtime environment. */
export async function createRuntimeAgentBackgroundSession(args: {
  environmentId: string
  worktreeId: string
  tabId: string
  leafId: string
  agent: TuiAgent
  prompt?: string
  startupPlan: AgentStartupPlan
  launchOverrides?: AgentLaunchOverrides | null
  effectiveAgentArgs: string
  paneEnv: Record<string, string>
  launchToken: string
  title?: string
}): Promise<{ runtimeTerminalHandle: string; ptyId: string }> {
  const created = await createRuntimeAgentBackgroundTerminal({
    environmentId: args.environmentId,
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    agent: args.agent,
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.startupPlan.sessionOptions ? { sessionOptions: args.startupPlan.sessionOptions } : {}),
    ...(args.launchOverrides == null
      ? {}
      : { agentArgs: args.effectiveAgentArgs, useLaunchOverrides: true }),
    legacy: {
      command: args.startupPlan.launchCommand,
      env: args.paneEnv,
      ...(args.startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: args.startupPlan.startupCommandDelivery }
        : {}),
      launchConfig: args.startupPlan.launchConfig,
      launchToken: args.launchToken,
      ...(args.title ? { title: args.title } : {})
    }
  })
  return {
    runtimeTerminalHandle: created.terminal.handle,
    ptyId: toRemoteRuntimePtyId(created.terminal.handle, args.environmentId)
  }
}
