import {
  agentLaunchOverridesToSessionOptionValues,
  type AgentLaunchOverrides
} from '../../../shared/agent-launch-overrides'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

type LaunchSettings = Pick<
  GlobalSettings,
  'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv' | 'terminalWindowsShell'
>

/** Resolve the exact launch inputs owned by a renderer background session. */
export function resolveAgentBackgroundLaunchSettings(args: {
  agent: TuiAgent
  overrides?: AgentLaunchOverrides | null
  settings: LaunchSettings | null | undefined
  platform: NodeJS.Platform
  isRemote: boolean
}): {
  cmdOverrides: Partial<Record<TuiAgent, string>>
  agentArgs: string
  agentEnv: Record<string, string>
  sessionOptions: Record<string, SessionOptionValue> | undefined
  startupShell: AgentStartupShell
} {
  const inheritedAgentArgs = resolveTuiAgentLaunchArgs(args.agent, args.settings?.agentDefaultArgs)
  return {
    cmdOverrides: args.settings?.agentCmdOverrides ?? {},
    agentArgs: args.overrides?.agentArgs?.trim() ? args.overrides.agentArgs : inheritedAgentArgs,
    agentEnv: resolveTuiAgentLaunchEnv(args.agent, args.settings?.agentDefaultEnv),
    sessionOptions: agentLaunchOverridesToSessionOptionValues(args.overrides),
    startupShell: resolveStartupShell(
      args.platform,
      resolveLocalWindowsAgentStartupShell({
        platform: args.platform,
        isRemote: args.isRemote,
        terminalWindowsShell: args.settings?.terminalWindowsShell
      })
    )
  }
}
