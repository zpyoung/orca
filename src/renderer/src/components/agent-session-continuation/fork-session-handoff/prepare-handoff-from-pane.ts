import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { resolveOwner } from '@/lib/resolve-owner'
import { useAppStore } from '@/store'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { prepareAgentSessionContinuationFromPane as prepareUpstreamAgentSessionContinuationFromPane } from '../../terminal-pane/terminal-agent-session-continuation'

export type ForkSessionHandoffSource = {
  sourcePaneKey: string | null
  sourceWorktreeId: string | null
  anchorWorktreeId: string
  sourceExecutionHostId: string | null
  providerSessionId: string | null
  vaultSessionId: string | null
  vaultAgent: TuiAgent | null
  capturePaneScrollback: (() => string) | null
}

export type ForkSessionHandoffRequest = AgentSessionContinuationRequest & {
  forkSource?: ForkSessionHandoffSource
}

export type ForkSessionHandoffRequestWithSource = ForkSessionHandoffRequest & {
  forkSource: ForkSessionHandoffSource
}

type PreparePaneArgs = Parameters<typeof prepareUpstreamAgentSessionContinuationFromPane>[0]

/** The host that owns the source pane's workspace; null when no row or several hosts claim it. */
function resolveSourceExecutionHostId(
  state: Parameters<typeof resolveOwner>[0],
  worktreeId: string
): string | null {
  const match = resolveOwner(state, { workspaceId: worktreeId })
  if (match.kind !== 'resolved') {
    return null
  }
  const { endpoint, at } = match.owner
  return endpoint.kind === 'environment' ? toRuntimeExecutionHostId(endpoint.environmentId) : at
}

/** Extends upstream pane capture with the live source identity used by handoff controls. */
export function prepareAgentSessionContinuationFromPane(
  args: PreparePaneArgs
): ForkSessionHandoffRequest | null {
  const request = prepareUpstreamAgentSessionContinuationFromPane(args)
  if (!request) {
    return null
  }

  const sourcePaneKey = makePaneKey(args.tabId, args.pane.leafId)
  const state = useAppStore.getState()
  return {
    ...request,
    forkSource: {
      sourcePaneKey,
      sourceWorktreeId: args.worktreeId,
      anchorWorktreeId: args.worktreeId,
      sourceExecutionHostId: resolveSourceExecutionHostId(state, args.worktreeId),
      providerSessionId: state.agentStatusByPaneKey[sourcePaneKey]?.providerSession?.id ?? null,
      vaultSessionId: null,
      vaultAgent: null,
      capturePaneScrollback: () => args.pane.serializeAddon.serialize({ scrollback: 800 })
    }
  }
}

/** Narrows a continuation request only when its fork source metadata is present. */
export function isForkSessionHandoffRequest(
  request: AgentSessionContinuationRequest
): request is ForkSessionHandoffRequestWithSource {
  return Boolean((request as ForkSessionHandoffRequest).forkSource)
}
