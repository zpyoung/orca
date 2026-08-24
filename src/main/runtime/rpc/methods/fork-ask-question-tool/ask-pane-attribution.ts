import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../../../orca-runtime'

export type AskAttributionParams = {
  paneKey?: string
  terminalHandle?: string
  worktreeId?: string
  workspaceId?: string
}

export type AskAttribution = {
  paneKey: string | null
  worktreeId: string | null
  /** Best terminal-handle identity available for the no-UI dispatch lookup (C7); '' when none. */
  dispatchLookupHandle: string
  /** True once any env claim was supplied at all — distinguishes "nothing to hand off to" from "nothing was even claimed". */
  anyIdentityClaimed: boolean
}

function resolveLivePaneKey(paneKey: string, runtime: OrcaRuntimeService): string | undefined {
  return parsePaneKey(paneKey) !== null
    ? (runtime.getAgentStatusTerminalHandleForPaneKey(paneKey) ?? undefined)
    : undefined
}

/**
 * Resolves who owns an ask (tech.md C3): the server never trusts a `paneKey`/`terminalHandle`
 * env claim without validating it against live runtime state, falling back through
 * terminal handle then worktree/workspace scope to no attribution at all.
 */
export function resolveAskAttribution(
  params: AskAttributionParams,
  runtime: OrcaRuntimeService
): AskAttribution {
  const anyIdentityClaimed = Boolean(
    params.paneKey || params.terminalHandle || params.worktreeId || params.workspaceId
  )

  const liveHandle = params.paneKey ? resolveLivePaneKey(params.paneKey, runtime) : undefined
  if (params.paneKey && liveHandle) {
    return {
      paneKey: params.paneKey,
      worktreeId: runtime.getTerminalWorktreeIdForPaneKey(params.paneKey),
      dispatchLookupHandle: liveHandle,
      anyIdentityClaimed
    }
  }

  const resolvedPaneKey = params.terminalHandle ? runtime.getTerminalPaneKey(params.terminalHandle) : null
  if (resolvedPaneKey) {
    return {
      paneKey: resolvedPaneKey,
      worktreeId: runtime.getTerminalWorktreeIdForPaneKey(resolvedPaneKey),
      dispatchLookupHandle: params.terminalHandle as string,
      anyIdentityClaimed
    }
  }

  return {
    paneKey: null,
    worktreeId: params.worktreeId ?? params.workspaceId ?? null,
    dispatchLookupHandle: params.terminalHandle ?? '',
    anyIdentityClaimed
  }
}
