import {
  normalizeAgentLaunchOverrides,
  type AgentLaunchOverrides
} from '../../../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import type { AutomationLaunchOverridesGate } from './automation-launch-overrides-gate'

/** Build the optional launch-override fields for a new automation. */
export function buildAutomationLaunchOverridesCreateFields(
  value: AgentLaunchOverrides,
  gate: AutomationLaunchOverridesGate
): { launchOverrides?: AgentLaunchOverrides } {
  const normalized = normalizeAgentLaunchOverrides(value)
  return gate === 'supported' && normalized ? { launchOverrides: normalized } : {}
}

/** Build the nullable launch-override patch for an existing automation. */
export function buildAutomationLaunchOverridesUpdateFields(
  value: AgentLaunchOverrides,
  gate: AutomationLaunchOverridesGate
): { launchOverrides?: AgentLaunchOverrides | null } {
  if (gate !== 'supported') {
    return {}
  }
  return { launchOverrides: normalizeAgentLaunchOverrides(value) ?? null }
}
