import {
  agentLaunchOverridesToSessionOptionValues,
  type AgentLaunchOverrides
} from '../../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'

/** Apply explicit launch overrides to inherited background-session settings. */
export function resolveAgentBackgroundLaunchSettings(args: {
  inheritedAgentArgs: string
  overrides?: AgentLaunchOverrides | null
}): {
  agentArgs: string
  sessionOptions: Record<string, SessionOptionValue> | undefined
} {
  return {
    agentArgs: args.overrides?.agentArgs?.trim()
      ? args.overrides.agentArgs
      : args.inheritedAgentArgs,
    sessionOptions: agentLaunchOverridesToSessionOptionValues(args.overrides)
  }
}
