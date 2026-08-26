import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/types'

/** Mark a background agent workspace trusted when its provider supports preflight trust. */
export async function markAgentBackgroundWorkspaceTrusted(args: {
  agent: TuiAgent
  workspacePath: string
  connectionId: string | null
}): Promise<void> {
  const preset = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preset || !args.workspacePath || !window.api.agentTrust?.markTrusted) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Best-effort: the user can still accept the trust prompt.
  }
}
