import { AgentLaunchOverridesFields } from '@/components/fork-automation-launch-settings/AgentLaunchOverridesFields'
import type {
  AgentLaunchOptionSelection,
  AgentLaunchOverrides
} from '../../../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import {
  getTuiAgentDefaultArgs,
  resolveTuiAgentLaunchArgs
} from '../../../../../shared/tui-agent-launch-defaults'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../../shared/tui-agent'

/** Render launch overrides for a source-control action recipe draft. */
export function SourceControlAgentLaunchOverridesFields(props: {
  agent: TuiAgent | null
  agentArgs: string
  /** False when the launch would be structured native chat, which reads no CLI arguments. */
  agentArgsApply: boolean
  launchOptions: AgentLaunchOptionSelection
  settings: Pick<GlobalSettings, 'agentDefaultArgs'> | null | undefined
  onChange: (updater: (current: AgentLaunchOverrides) => AgentLaunchOverrides) => void
}): React.JSX.Element {
  return (
    <AgentLaunchOverridesFields
      agent={props.agent}
      value={{
        ...props.launchOptions,
        ...(props.agentArgs ? { agentArgs: props.agentArgs } : {})
      }}
      onChange={props.onChange}
      agentArgsPlaceholder={props.agent ? getTuiAgentDefaultArgs(props.agent) : undefined}
      inheritedAgentArgs={
        props.agent
          ? resolveTuiAgentLaunchArgs(props.agent, props.settings?.agentDefaultArgs)
          : null
      }
      showAgentArgs={props.agentArgsApply}
      idPrefix="source-control-agent"
    />
  )
}
