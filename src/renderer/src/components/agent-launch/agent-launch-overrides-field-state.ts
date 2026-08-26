import {
  findCatalogModel,
  getAgentSessionOptionCatalog,
  type AgentSessionOptionCatalog,
  type CatalogOption
} from '../../../../shared/agent-session-option-catalog'
import {
  describeOverriddenOptionIds,
  type AgentLaunchOverrides
} from '../../../../shared/agent-launch-overrides'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type AgentLaunchFieldEntry = {
  value: SessionOptionValue | undefined
  label?: string
  description?: string
  opaque?: boolean
}

export type AgentLaunchOptionDescriptor = {
  id: string
  label: string
  description?: string
  kind: CatalogOption['kind']['type']
  entries: AgentLaunchFieldEntry[]
  value: SessionOptionValue | undefined
}

export type AgentLaunchOverridesFieldState = {
  catalog: AgentSessionOptionCatalog | null
  modelEntries: AgentLaunchFieldEntry[]
  optionDescriptors: AgentLaunchOptionDescriptor[]
  shadowedIds: ReadonlySet<string>
  unknownModelId: string | null
}

function optionCanApplyAtLaunch(option: CatalogOption): boolean {
  return Boolean(option.apply.launchArgs || option.apply.composedIntoModel)
}

function optionEntries(option: CatalogOption): AgentLaunchFieldEntry[] {
  if (option.kind.type === 'boolean') {
    return [{ value: undefined }, { value: true }, { value: false }]
  }
  return [
    { value: undefined },
    ...option.kind.choices.map((choice) => ({
      value: choice.value,
      label: choice.label,
      ...(choice.description ? { description: choice.description } : {})
    }))
  ]
}

function emptyFieldState(): AgentLaunchOverridesFieldState {
  return {
    catalog: null,
    modelEntries: [],
    optionDescriptors: [],
    shadowedIds: new Set(),
    unknownModelId: null
  }
}

/** Derive the catalog-backed controls for persisted launch overrides. */
export function buildAgentLaunchOverridesFieldState(
  agent: TuiAgent | null,
  value: AgentLaunchOverrides
): AgentLaunchOverridesFieldState {
  if (!agent) {
    return emptyFieldState()
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog) {
    return emptyFieldState()
  }

  const selectedModelId = value.model?.trim() || null
  const selectedModel = selectedModelId ? findCatalogModel(catalog, selectedModelId) : undefined
  const unknownModelId = selectedModelId && !selectedModel ? selectedModelId : null
  const options = selectedModel
    ? selectedModel.options
    : unknownModelId
      ? (catalog.unknownModelOptions ?? [])
      : []
  const shadowedIds = new Set(describeOverriddenOptionIds(agent, value))
  const modelEntries: AgentLaunchFieldEntry[] = [
    { value: undefined },
    ...catalog.models.map((model) => ({
      value: model.id,
      label: model.label,
      ...(model.description ? { description: model.description } : {})
    })),
    ...(unknownModelId ? [{ value: unknownModelId, label: unknownModelId, opaque: true }] : [])
  ]
  const optionDescriptors = options.filter(optionCanApplyAtLaunch).map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    kind: option.kind.type,
    entries: optionEntries(option),
    value: value.optionValues?.[option.id]
  }))

  return { catalog, modelEntries, optionDescriptors, shadowedIds, unknownModelId }
}
