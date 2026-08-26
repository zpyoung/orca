import type { AgentType } from '../../../../shared/agent-status-types'
import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import { normalizeAgentLaunchOverrides } from '../../../../shared/agent-launch-overrides'
import { resolveAutomationModelDiscoveryHostKey } from './native-chat-session-option-discovery'

// Why: every native-chat pane replays discovery on mount, so an unguarded pass
// would issue one full automations list per pane for the same probe result.
const inFlightRetirements = new Map<string, Promise<void>>()

async function retireStaleAutomationModels(
  agent: AgentType,
  hostKey: string,
  discoveredIds: ReadonlySet<string>
): Promise<void> {
  const automations = await window.api.automations.list()
  for (const automation of automations) {
    const model = automation.launchOverrides?.model
    if (automation.agentId !== agent || !model || discoveredIds.has(model)) {
      continue
    }
    // A probe only disproves models on the host it ran against; an automation
    // targeting a different SSH/WSL host may legitimately still have this model.
    if (resolveAutomationModelDiscoveryHostKey(automation) !== hostKey) {
      continue
    }
    const { model: _retiredModel, ...remaining } = automation.launchOverrides ?? {}
    await window.api.automations.update({
      id: automation.id,
      updates: {
        launchOverrides: normalizeAgentLaunchOverrides(remaining) ?? null
      }
    })
  }
}

/** Retire automation models disproven by a non-empty authoritative host discovery. */
export async function retireAutomationLaunchModelsMissingFromDiscovery(
  agent: AgentType,
  hostKey: string,
  models: readonly CatalogModel[]
): Promise<void> {
  if (
    !getAgentSessionOptionCatalog(agent)?.discoveredModelsAreAuthoritative ||
    models.length === 0
  ) {
    return
  }
  const ids = models.map((model) => model.id)
  const key = `${agent} ${hostKey} ${[...ids].sort().join(' ')}`
  const existing = inFlightRetirements.get(key)
  if (existing) {
    return existing
  }
  const pass = retireStaleAutomationModels(agent, hostKey, new Set(ids)).finally(() => {
    inFlightRetirements.delete(key)
  })
  inFlightRetirements.set(key, pass)
  return pass
}
