import { normalizeAgentLaunchOverrides } from '../shared/agent-launch-overrides'
import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from '../shared/agent-session-option-catalog'
import type { Automation } from '../shared/automations-types'

/** Format persisted automation launch overrides for human-readable CLI output. */
export function formatAutomationLaunchOverrides(
  automation: Pick<Automation, 'agentId' | 'launchOverrides'>
): string | null {
  const overrides = normalizeAgentLaunchOverrides(automation.launchOverrides)
  if (!overrides) {
    return null
  }
  const parts: string[] = [automation.agentId]
  const catalog = getAgentSessionOptionCatalog(automation.agentId)
  const model = catalog && overrides.model ? findCatalogModel(catalog, overrides.model) : undefined
  if (overrides.model) {
    parts.push(model?.label ?? overrides.model)
  }
  for (const [id, value] of Object.entries(overrides.optionValues ?? {})) {
    const option =
      (catalog && findCatalogOption(model, id)) ??
      (!model ? catalog?.unknownModelOptions?.find((candidate) => candidate.id === id) : undefined)
    const label = option?.label ?? id
    parts.push(value === true ? label : `${label}: ${value === false ? 'Off' : value}`)
  }
  if (overrides.agentArgs) {
    parts.push(overrides.agentArgs)
  }
  return parts.join(' · ')
}
