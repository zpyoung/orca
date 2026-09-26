import {
  normalizeAgentLaunchOverrides,
  type AgentLaunchOptionSelection
} from '../../../../../shared/fork-automation-launch-settings/agent-launch-overrides'

export function toRepoActionLaunchOptions(
  value: AgentLaunchOptionSelection
): AgentLaunchOptionSelection | null {
  const normalized = normalizeAgentLaunchOverrides(value)
  if (!normalized?.model && !normalized?.optionValues) {
    return null
  }
  return {
    ...(normalized.model ? { model: normalized.model } : {}),
    ...(normalized.optionValues ? { optionValues: normalized.optionValues } : {})
  }
}
