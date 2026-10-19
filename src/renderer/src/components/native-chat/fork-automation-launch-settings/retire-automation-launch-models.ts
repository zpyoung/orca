import type { AgentType } from '../../../../../shared/agent-status-types'
import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../../shared/agent-session-option-catalog'
import { normalizeAutomationLaunchOverrides } from '../../../../../shared/fork-automation-launch-settings/automation-launch-overrides-migration'
import {
  listAutomationsForTarget,
  updateAutomationForTarget,
  type AutomationHostTarget
} from '@/components/automations/automation-host-client'
import { RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX } from '../../../../../shared/commit-message-host-key'
import { resolveAutomationModelDiscoveryHostKey } from './automation-model-discovery-host-key'

// Why: every native-chat pane replays discovery on mount, so an unguarded pass
// would issue one full automations list per pane for the same probe result.
const inFlightRetirements = new Map<string, Promise<void>>()

// Why: the probe ran on one host, so its disproof applies to the authority serving that host,
// never to whichever server happens to be focused. Desktop serves local, WSL and direct SSH.
function automationAuthorityTargetForHostKey(hostKey: string): AutomationHostTarget {
  return hostKey.startsWith(RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX)
    ? {
        kind: 'environment',
        environmentId: hostKey.slice(RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX.length)
      }
    : { kind: 'local' }
}

async function retireStaleAutomationModels(
  agent: AgentType,
  hostKey: string,
  discoveredIds: ReadonlySet<string>
): Promise<void> {
  const target = automationAuthorityTargetForHostKey(hostKey)
  const automations = await listAutomationsForTarget(target)
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
    await updateAutomationForTarget(
      automation,
      { launchOverrides: normalizeAutomationLaunchOverrides(remaining) ?? null },
      target
    )
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
