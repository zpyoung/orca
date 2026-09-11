import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { canContinueAiVaultSessionInNewSession } from '../../right-sidebar/ai-vault-session-continuation'
import { isKnownAiVaultResumeWorkspaceTarget } from '../../right-sidebar/ai-vault-session-resume'
import type {
  AiVaultSessionResumeActions,
  AiVaultSessionResumeTargetState
} from '../../right-sidebar/ai-vault-session-resume'
import type { AiVaultSession } from '../../../../../shared/ai-vault-types'

export type AiVaultSessionHandoffLaunchTarget =
  | { status: 'missing' }
  | { status: 'ready'; worktreeId: string }

/** Selects the active workspace identity even when same-host resume is disabled. */
export function resolveAiVaultSessionHandoffWorktreeId(
  session: AiVaultSession,
  resumeActions: AiVaultSessionResumeActions | null
): string | null {
  const worktreeId =
    resumeActions?.worktree.disabled === false
      ? resumeActions.worktree.worktreeId
      : (resumeActions?.newTab.worktreeId ?? resumeActions?.worktree.worktreeId ?? null)
  return canContinueAiVaultSessionInNewSession(session, worktreeId) ? worktreeId : null
}

/** Resolves a Vault handoff destination without applying transcript resume constraints. */
export function resolveAiVaultSessionHandoffLaunchTarget(args: {
  sessionFilePath: string | null
  sessionExecutionHostId?: AiVaultSession['executionHostId'] | null
  activeWorktreeId: string | null
  targetWorktreeId?: string
  targetState: AiVaultSessionResumeTargetState
}): AiVaultSessionHandoffLaunchTarget {
  const targetWorktreeId = args.targetWorktreeId ?? args.activeWorktreeId
  if (
    !targetWorktreeId ||
    !isKnownAiVaultResumeWorkspaceTarget(args.targetState, targetWorktreeId)
  ) {
    return { status: 'missing' }
  }
  return { status: 'ready', worktreeId: targetWorktreeId }
}

/** Resolves a Vault handoff destination and reports a missing workspace to the operator. */
export function resolveAiVaultSessionHandoffLaunchTargetOrNotify(
  args: Parameters<typeof resolveAiVaultSessionHandoffLaunchTarget>[0]
): Extract<AiVaultSessionHandoffLaunchTarget, { status: 'ready' }> | null {
  const target = resolveAiVaultSessionHandoffLaunchTarget(args)
  if (target.status === 'ready') {
    return target
  }
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
      'Open a workspace before resuming a session.'
    )
  )
  return null
}
