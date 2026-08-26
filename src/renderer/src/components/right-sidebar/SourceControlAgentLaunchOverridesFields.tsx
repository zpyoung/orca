import { AgentLaunchOverridesFields } from '@/components/agent-launch/AgentLaunchOverridesFields'
import type {
  AgentLaunchOptionSelection,
  AgentLaunchOverrides
} from '../../../../shared/agent-launch-overrides'
import {
  getTuiAgentDefaultArgs,
  resolveTuiAgentLaunchArgs
} from '../../../../shared/tui-agent-launch-defaults'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'

/** Render launch overrides for a source-control action recipe draft. */
export function SourceControlAgentLaunchOverridesFields(props: {
  agent: TuiAgent | null
  agentArgs: string
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
      idPrefix="source-control-agent"
    />
  )
}
