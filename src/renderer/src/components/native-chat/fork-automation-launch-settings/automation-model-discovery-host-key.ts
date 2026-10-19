import { getRuntimeGitScope } from '@/runtime/runtime-git-client-context'
import { runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'
import { useAppStore } from '@/store'
import { getIndexedRepoMap } from '@/store/worktree-repo-index'
import { getAutomationRunRepoId } from '../../../../../shared/automation-run-identity'
import type { Automation } from '../../../../../shared/automations-types'
import { resolveNativeChatModelDiscoveryHostKey } from '../native-chat-session-option-discovery'

/** Host key for an automation's own run target, or null when its repo is unknown. */
export function resolveAutomationModelDiscoveryHostKey(
  automation: Pick<Automation, 'projectId' | 'runContext'>
): string | null {
  const state = useAppStore.getState()
  const repoId = getAutomationRunRepoId(automation)
  const repo = getIndexedRepoMap(state.repos).get(repoId)
  const target = runtimeTargetForRepoOwner(state, repoId)
  if (!repo || !target) {
    return null
  }
  const scope = getRuntimeGitScope(target, repo.connectionId ?? null)
  return resolveNativeChatModelDiscoveryHostKey(state, null, repo.path, scope)
}
