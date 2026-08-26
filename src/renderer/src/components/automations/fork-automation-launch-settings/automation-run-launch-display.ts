import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog,
  type CatalogModel,
  type CatalogOption
} from '../../../../../shared/agent-session-option-catalog'
import type { AutomationRunLaunchSettings } from '../../../../../shared/fork-automation-launch-settings/automation-run-launch-settings'
import type { SessionOptionValue } from '../../../../../shared/native-chat-session-options'
import { translate } from '@/i18n/i18n'

export type AutomationRunLaunchDisplay = {
  summary: string
  agentArgs: string | null
}

function findOption(
  id: string,
  model: CatalogModel | undefined,
  models: readonly CatalogModel[],
  unknownOptions: readonly CatalogOption[]
): CatalogOption | undefined {
  return (
    findCatalogOption(model, id) ??
    models.flatMap((entry) => entry.options).find((option) => option.id === id) ??
    unknownOptions.find((option) => option.id === id)
  )
}

function formatOptionValue(label: string, value: SessionOptionValue): string {
  if (value === true) {
    return label
  }
  if (value === false) {
    return `${label}: ${translate('auto.components.agent.launch.AgentLaunchOverridesFields.off', 'Off')}`
  }
  return `${label}: ${value}`
}

/** Format immutable launch provenance for automation run history. */
export function formatAutomationRunLaunchSettings(
  settings: AutomationRunLaunchSettings | null | undefined,
  agentLabel: string
): AutomationRunLaunchDisplay | null {
  if (!settings) {
    return null
  }
  const catalog = getAgentSessionOptionCatalog(settings.agentId)
  const modelSetting = settings.options.model
  const modelId =
    modelSetting?.source !== 'raw_args' && typeof modelSetting?.value === 'string'
      ? modelSetting.value
      : null
  const model = catalog && modelId ? findCatalogModel(catalog, modelId) : undefined
  const parts = [agentLabel]
  if (modelId) {
    parts.push(model?.label ?? modelId)
  }
  for (const [id, setting] of Object.entries(settings.options)) {
    if (id === 'model' || setting.source === 'raw_args' || setting.value === undefined) {
      continue
    }
    const option = catalog
      ? findOption(id, model, catalog.models, catalog.unknownModelOptions ?? [])
      : undefined
    parts.push(formatOptionValue(option?.label ?? id, setting.value))
  }
  return {
    summary: parts.join(' · '),
    agentArgs: settings.agentArgs?.value ?? null
  }
}

/** Join launch display segments for titles and compact breadcrumb content. */
export function automationRunLaunchDisplayText(display: AutomationRunLaunchDisplay): string {
  return display.agentArgs ? `${display.summary} · ${display.agentArgs}` : display.summary
}
