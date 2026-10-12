import type { AgentLaunchOptionSelection } from '../../../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import { normalizeAutomationLaunchOverrides } from '../../../../../shared/fork-automation-launch-settings/automation-launch-overrides-migration'
import type { AutomationLaunchOverridesGate } from './automation-launch-overrides-gate'

/** Build the optional launch-override fields for a new automation. */
export function buildAutomationLaunchOverridesCreateFields(
  value: AgentLaunchOptionSelection,
  gate: AutomationLaunchOverridesGate
): { launchOverrides?: AgentLaunchOptionSelection } {
  const normalized = normalizeAutomationLaunchOverrides(value)
  return gate === 'supported' && normalized ? { launchOverrides: normalized } : {}
}

/** Build the nullable launch-override patch for an existing automation. */
export function buildAutomationLaunchOverridesUpdateFields(
  value: AgentLaunchOptionSelection,
  gate: AutomationLaunchOverridesGate
): { launchOverrides?: AgentLaunchOptionSelection | null } {
  if (gate !== 'supported') {
    return {}
  }
  return { launchOverrides: normalizeAutomationLaunchOverrides(value) ?? null }
}
