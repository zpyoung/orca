import type { AgentLaunchOptionSelection } from './agent-launch-overrides'

/** Launch overrides as stored before raw `agentArgs` moved to the automation's `extraAgentArgs`. */
export function legacyLaunchOverrides(
  fields: AgentLaunchOptionSelection & { agentArgs: string }
): AgentLaunchOptionSelection {
  return fields
}
