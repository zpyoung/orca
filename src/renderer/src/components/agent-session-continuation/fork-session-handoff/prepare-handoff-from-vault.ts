import { prepareAiVaultSessionContinuation as prepareUpstreamAiVaultSessionContinuation } from '../../right-sidebar/ai-vault-session-continuation'
import type { ForkSessionHandoffRequest } from './prepare-handoff-from-pane'

type PrepareVaultArgs = Parameters<typeof prepareUpstreamAiVaultSessionContinuation>[0]

/** Extends upstream Vault capture with its archived source and anchor identities. */
export function prepareAiVaultSessionContinuation(
  args: PrepareVaultArgs
): ForkSessionHandoffRequest {
  const request = prepareUpstreamAiVaultSessionContinuation(args)
  return {
    ...request,
    forkSource: {
      sourcePaneKey: null,
      sourceWorktreeId: null,
      anchorWorktreeId: args.targetWorktreeId,
      sourceExecutionHostId: args.session.executionHostId,
      providerSessionId: args.session.sessionId,
      vaultSessionId: args.session.sessionId,
      vaultAgent: args.session.agent,
      capturePaneScrollback: null
    }
  }
}
