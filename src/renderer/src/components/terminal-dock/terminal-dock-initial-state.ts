import type { AgentType } from '../../../../shared/agent-status-types'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

/** Launch-time decision; an existing host or local entry is always authoritative. */
export function shouldDockTerminalComposerByDefault(args: {
  enabled: boolean
  agent: AgentType | null | undefined
  hasPersistedDecision: boolean
}): boolean {
  return args.enabled && isTuiAgent(args.agent) && !args.hasPersistedDecision
}
