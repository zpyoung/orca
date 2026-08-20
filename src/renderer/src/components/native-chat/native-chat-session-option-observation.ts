// Turns what an agent recorded about itself into the value shape the session-option
// surface reports. The provider names its model the way its API does
// (`claude-opus-5`); the picker lists catalog ids (`opus`, or a host-discovered
// `opus[1m]`). Resolving between them needs the host's model list, which is why this
// mapping lives in the renderer and never in the transcript readers.

import {
  getAgentSessionOptionCatalog,
  type CatalogModel,
  type CatalogOption
} from '../../../../shared/agent-session-option-catalog'
import type {
  AgentType,
  NativeChatSessionOptionObservation
} from '../../../../shared/native-chat-types'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { matchNativeChatCatalogModelId } from '../../../../shared/native-chat-session-option-state'

/**
 * Resolve the catalog id for a model the provider named, most specific first: an
 * exact id in the host's list, then the seed family the id contains, then the raw
 * id — which the picker renders as its own row rather than dropping the selection.
 */
function resolveObservedModelId(
  agent: AgentType,
  models: readonly CatalogModel[],
  reported: string
): string {
  if (models.some((model) => model.id === reported)) {
    return reported
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  return (catalog && matchNativeChatCatalogModelId(catalog, reported)) || reported
}

/**
 * The observation as reportable option values, or null when it names no model.
 *
 * Null rather than an effort-only record because the surface keys every option
 * value by model id: an effort with no model has nowhere to land.
 */
export function nativeChatReportedValuesFromObservation(args: {
  observation: NativeChatSessionOptionObservation
  agent: AgentType
  /** The list the picker is showing — discovered when available, else the seed. */
  models: readonly CatalogModel[]
}): Record<string, SessionOptionValue> | null {
  const reportedModel = args.observation.model?.trim()
  if (!reportedModel) {
    return null
  }
  const modelId = resolveObservedModelId(args.agent, args.models, reportedModel)
  const values: Record<string, SessionOptionValue> = { model: modelId }
  const effort = args.observation.effort?.trim()
  // Why: a model with no effort control would render the value as an invented
  // choice row. Same rule the terminal scrape applies to a reported effort.
  if (
    effort &&
    optionsForModelId(args.agent, args.models, modelId).some((o) => o.id === 'effort')
  ) {
    values.effort = effort
  }
  return values
}

/** The options the picker will draw this model under. Resolved the way
 *  `withTrackedNativeChatModel` reconciles a tracked id: the host's list first, then
 *  the seed, and nothing at all for an id neither one knows. */
function optionsForModelId(
  agent: AgentType,
  models: readonly CatalogModel[],
  modelId: string
): readonly CatalogOption[] {
  const listed = models.find((model) => model.id === modelId)
  if (listed) {
    return listed.options
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  return catalog?.models.find((model) => model.id === modelId)?.options ?? []
}
