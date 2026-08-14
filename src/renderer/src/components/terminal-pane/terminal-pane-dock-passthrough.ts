import type { AgentStatusState } from '../../../../shared/agent-status-types'

const NON_WORKING_STATES = new Set<AgentStatusState>(['blocked', 'waiting', 'done'])

/** Whether a live agentStatusByPaneKey transition should auto-exit passthrough mode.
 *  Scoped to a working->non-working transition (not a full status removal, which is the
 *  separate confirmed-agent-exit signal that undocks instead) and only for agents with a
 *  hook-reported status source — agents without one never get a spurious auto-exit. */
export function shouldAutoExitPassthroughOnAgentStatus(args: {
  previousState: AgentStatusState | null
  nextState: AgentStatusState | null
  agentType: string | null | undefined
}): boolean {
  if (args.previousState !== 'working') {
    return false
  }
  if (!args.nextState || !NON_WORKING_STATES.has(args.nextState)) {
    return false
  }
  // Observing the transition in agentStatusByPaneKey is itself proof that this
  // pane has a status source, including OSC-backed and custom agents.
  return args.agentType != null && args.agentType.length > 0
}
