import type { AgentStatusState } from '../../../../shared/agent-status-types'

const NON_WORKING_STATES = new Set<AgentStatusState>(['blocked', 'waiting', 'done'])

// Command Code has no hooks — its working/done rows are synthesized from terminal-output
// scraping (see pty-connection.ts's onCommandCodeWorking/onCommandCodeDone), so a repaint
// can flip the row without any real turn boundary. Every other agentType reaches this slice
// only via the hook IPC path (useIpcEvents.ts), so its transitions are trustworthy.
const SYNTHESIZED_STATUS_AGENT_TYPES = new Set(['command-code'])

/** Whether a live agentStatusByPaneKey transition should auto-exit passthrough mode.
 *  Scoped to a working->non-working transition (not a full status removal, which is the
 *  separate confirmed-agent-exit signal that undocks instead) and only for agents with a
 *  genuine hook-reported status source — agents without one, or whose status is scraped
 *  rather than hook-fed, never get a spurious auto-exit. */
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
  if (!args.agentType || SYNTHESIZED_STATUS_AGENT_TYPES.has(args.agentType)) {
    return false
  }
  return true
}
