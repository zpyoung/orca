import type { AgentType } from '../../../../../shared/agent-status-types'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'

/** Decides whether a recognized agent session should open its composer dock. */
export function shouldDockTerminalComposerByDefault(args: {
  enabled: boolean
  autoDockNewPanes: boolean
  agent: AgentType | null | undefined
  hasPersistedDecision: boolean
}): boolean {
  return (
    args.enabled && args.autoDockNewPanes && isTuiAgent(args.agent) && !args.hasPersistedDecision
  )
}
