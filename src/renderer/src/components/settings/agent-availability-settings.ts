import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildAgentAvailabilitySettingsUpdate } from '../../../../shared/tui-agent-selection'

export { buildAgentAvailabilitySettingsUpdate }

export type AgentAvailabilityUpdateQueueOptions = {
  getSettings: () => GlobalSettings | null | undefined
  fallbackSettings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  agentId: TuiAgent
  enabled: boolean
}

export function createAgentAvailabilityUpdateQueue(): (
  options: AgentAvailabilityUpdateQueueOptions
) => Promise<void> {
  const enqueue = createAgentSettingsUpdateQueue()
  return ({ agentId, enabled, ...options }) =>
    enqueue({
      ...options,
      buildUpdate: (settings) => buildAgentAvailabilitySettingsUpdate(settings, agentId, enabled)
    })
}
