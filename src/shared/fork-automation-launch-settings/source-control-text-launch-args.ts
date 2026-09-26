import type { AgentLaunchOptionSelection } from './agent-launch-overrides'
import { resolveAgentLaunchOverrides } from './agent-launch-overrides'
import { isCustomAgentId } from '../commit-message-agent-spec'
import { quoteStartupArg, tokenizeStartupCommand } from '../tui-agent-startup-shell'
import type { ResolvedSourceControlAiGenerationParams } from '../source-control-ai'
import type { TuiAgent } from '../tui-agent'

/** Build one-shot recipe arguments with structured values first and raw values last. */
export function resolveSourceControlTextLaunchAgentArgs(args: {
  agentId: TuiAgent | 'custom'
  launchOptions?: AgentLaunchOptionSelection | null
  agentArgs?: string
}): string | undefined {
  const rawArgs = args.agentArgs?.trim()
  if (isCustomAgentId(args.agentId) || !args.launchOptions) {
    return args.agentArgs
  }
  if (rawArgs && !tokenizeStartupCommand(rawArgs, 'posix').ok) {
    return args.agentArgs
  }
  const resolved = resolveAgentLaunchOverrides(args.agentId, {
    ...args.launchOptions,
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {})
  })
  return resolved.args.length > 0
    ? resolved.args.map((arg) => quoteStartupArg(arg, 'posix')).join(' ')
    : undefined
}

/** Materialize saved structured recipe choices for a one-shot text-generation process. */
export function materializeSourceControlTextGenerationParams(
  params: ResolvedSourceControlAiGenerationParams
): ResolvedSourceControlAiGenerationParams {
  if (params.recipeAgentArgs !== undefined || isCustomAgentId(params.agentId)) {
    return params
  }
  const launchOptions = params.launchOptions
  const recipeModel = launchOptions?.model
  const effort = recipeModel ? launchOptions?.optionValues?.effort : undefined
  const agentArgs = resolveSourceControlTextLaunchAgentArgs({
    agentId: params.agentId,
    launchOptions,
    agentArgs: params.agentArgs
  })
  return {
    ...params,
    model: recipeModel ?? params.model,
    ...(typeof effort === 'string' ? { thinkingLevel: effort } : {}),
    ...(agentArgs !== undefined ? { agentArgs } : {}),
    recipeAgentArgs: params.agentArgs ?? ''
  }
}
