import {
  normalizeAgentLaunchOverrides,
  type AgentLaunchOverrides
} from '../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from '../../../shared/agent-session-option-catalog'
import { AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { RuntimeClient } from '../../runtime-client'
import { RuntimeClientError } from '../../runtime-client'

export const AUTOMATION_LAUNCH_OVERRIDE_FLAGS = ['model', 'effort', 'agent-args'] as const
const INHERIT_VALUE = 'inherit'

type LaunchOverrideFlag = (typeof AUTOMATION_LAUNCH_OVERRIDE_FLAGS)[number]

function readFlag(
  flags: Map<string, string | boolean>,
  name: LaunchOverrideFlag
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `--${name} requires a value`)
  }
  return value
}

/** Return whether the command carries any launch-override mutation. */
export function hasAutomationLaunchOverrideFlags(flags: Map<string, string | boolean>): boolean {
  return AUTOMATION_LAUNCH_OVERRIDE_FLAGS.some((flag) => flags.has(flag))
}

function validateLaunchSelection(agent: TuiAgent, value: AgentLaunchOverrides): void {
  const modelId = value.model
  if (!modelId) {
    if (value.optionValues?.effort !== undefined) {
      throw new RuntimeClientError('invalid_argument', '--effort requires --model')
    }
    return
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog?.modelApply.launchArgs) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Agent ${agent} does not support launch-time model selection.`
    )
  }
  const model = findCatalogModel(catalog, modelId)
  if (!model && !catalog.unknownModelOptions) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Agent ${agent} does not support model ${modelId}.`
    )
  }
  const effort = value.optionValues?.effort
  if (effort === undefined) {
    return
  }
  const option =
    findCatalogOption(model, 'effort') ??
    (!model
      ? catalog.unknownModelOptions?.find((candidate) => candidate.id === 'effort')
      : undefined)
  if (
    typeof effort !== 'string' ||
    option?.kind.type !== 'select' ||
    !option.kind.choices.some((choice) => choice.value === effort)
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Agent ${agent} model ${modelId} does not support effort ${String(effort)}.`
    )
  }
}

/** Clear structured launch selections after an automation changes agents. */
export function resetAutomationLaunchOverridesForAgentChange(
  current: AgentLaunchOverrides | null | undefined
): AgentLaunchOverrides | null | undefined {
  const normalized = normalizeAgentLaunchOverrides(current)
  if (!normalized?.model && !normalized?.optionValues) {
    return undefined
  }
  return normalizeAgentLaunchOverrides({ agentArgs: normalized.agentArgs }) ?? null
}

/** Parse create-time automation launch flags into a normalized override. */
export function getAutomationLaunchOverridesForCreate(
  flags: Map<string, string | boolean>,
  agent: TuiAgent
): AgentLaunchOverrides | undefined {
  const model = readFlag(flags, 'model')
  const effort = readFlag(flags, 'effort')
  const agentArgs = readFlag(flags, 'agent-args')
  if ([model, effort, agentArgs].includes(INHERIT_VALUE)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The inherit value is only supported by automations edit.'
    )
  }
  if (effort && !model) {
    throw new RuntimeClientError('invalid_argument', '--effort requires --model')
  }
  const value = normalizeAgentLaunchOverrides({
    model,
    ...(effort ? { optionValues: { effort } } : {}),
    agentArgs
  })
  if (value) {
    validateLaunchSelection(agent, value)
  }
  return value
}

/** Merge sparse edit flags over an automation's stored launch override. */
export function getAutomationLaunchOverridesForEdit(args: {
  flags: Map<string, string | boolean>
  agent: TuiAgent
  current: AgentLaunchOverrides | null | undefined
}): AgentLaunchOverrides | null | undefined {
  if (!hasAutomationLaunchOverrideFlags(args.flags)) {
    return undefined
  }
  const next = normalizeAgentLaunchOverrides(args.current) ?? {}
  const model = readFlag(args.flags, 'model')
  const effort = readFlag(args.flags, 'effort')
  const agentArgs = readFlag(args.flags, 'agent-args')
  if (model !== undefined) {
    if (model === INHERIT_VALUE) {
      delete next.model
    } else {
      next.model = model
    }
  }
  if (effort !== undefined) {
    if (effort === INHERIT_VALUE) {
      if (next.optionValues) {
        delete next.optionValues.effort
      }
    } else {
      if (!next.model) {
        throw new RuntimeClientError('invalid_argument', '--effort requires --model')
      }
      next.optionValues = { ...next.optionValues, effort }
    }
  }
  if (agentArgs !== undefined) {
    if (agentArgs === INHERIT_VALUE) {
      delete next.agentArgs
    } else {
      next.agentArgs = agentArgs
    }
  }
  const normalized = normalizeAgentLaunchOverrides(next)
  if (
    (model !== undefined && model !== INHERIT_VALUE) ||
    (effort !== undefined && effort !== INHERIT_VALUE)
  ) {
    validateLaunchSelection(args.agent, normalized ?? {})
  }
  return normalized ?? null
}

/** Refuse override mutations before a mixed-version runtime can strip the field. */
export async function assertAutomationLaunchOverridesRuntimeSupported(
  client: Pick<RuntimeClient, 'call'>,
  flags: Map<string, string | boolean>,
  force = false
): Promise<void> {
  if (!force && !hasAutomationLaunchOverrideFlags(flags)) {
    return
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'capability_unsupported',
      'Connected Orca runtime does not support automation launch settings. Update the Orca runtime and try again.'
    )
  }
}
