import { WorktreeSet } from '../../../../shared/rpc-contract/worktree-params'
import { displayNameUpdatePinsLabel } from '../../../../shared/worktree/display-name-provenance'
import { getWorkspaceStatusWarning } from '../../../../shared/workspace-status-warning'
import { defineMethod } from '../core'

export const WORKTREE_SET_METHOD = defineMethod({
  name: 'worktree.set',
  permission: 'workspace',
  params: WorktreeSet,
  handler: async (params, { runtime, clientKind }) => {
    const worktree = await runtime.updateManagedWorktreeMeta(params.worktree, {
      displayName: params.displayName,
      ...(params.firstAgentMessageRenameError === null
        ? { firstAgentMessageRenameError: null }
        : {}),
      ...(params.displayName !== undefined
        ? { displayNameIsPinned: displayNameUpdatePinsLabel(params.displayName) }
        : {}),
      linkedIssue: params.linkedIssue,
      linkedPR: params.linkedPR,
      suppressedGitHubPR: params.suppressedGitHubPR,
      linkedLinearIssue: params.linkedLinearIssue,
      linkedLinearIssueWorkspaceId: params.linkedLinearIssueWorkspaceId,
      linkedLinearIssueOrganizationUrlKey: params.linkedLinearIssueOrganizationUrlKey,
      linkedGitLabMR: params.linkedGitLabMR,
      linkedGitLabIssue: params.linkedGitLabIssue,
      linkedBitbucketPR: params.linkedBitbucketPR,
      linkedAzureDevOpsPR: params.linkedAzureDevOpsPR,
      linkedGiteaPR: params.linkedGiteaPR,
      linkedWorkItem: params.linkedWorkItem,
      linkedItems: params.linkedItems,
      ...(params.linkedItemsBase !== undefined ? { linkedItemsBase: params.linkedItemsBase } : {}),
      ...(params.linkedItemsSelectionChanged !== undefined
        ? { linkedItemsSelectionChanged: params.linkedItemsSelectionChanged }
        : {}),
      linkedTaskSourceContext: params.linkedTaskSourceContext,
      comment: params.comment,
      isArchived: params.isArchived,
      isUnread: params.isUnread,
      isPinned: params.isPinned,
      sortOrder: params.sortOrder,
      manualOrder: params.manualOrder,
      lastActivityAt: params.lastActivityAt,
      createdAt: params.createdAt,
      sparseDirectories: params.sparseDirectories,
      sparseBaseRef: params.sparseBaseRef,
      sparsePresetId: params.sparsePresetId,
      baseRef: params.baseRef,
      workspaceStatus: params.workspaceStatus,
      pushTarget: params.pushTarget,
      diffComments: params.diffComments,
      ...(params.diffCommentsBase !== undefined
        ? { diffCommentsBase: params.diffCommentsBase }
        : {}),
      mobileDiffReview: params.mobileDiffReview,
      // Why: only the desktop app writes group membership. `worktree.set` is on
      // the mobile allowlist as a whole and mobile has no group concept, so the
      // key is omitted (not set to undefined, which would clobber on merge)
      // rather than gating the whole method. 'runtime' still carries it, which is
      // the path a desktop write to an SSH-hosted worktree takes.
      ...(clientKind === 'mobile' ? {} : { projectGroupId: params.projectGroupId }),
      lineage:
        params.parentWorktree || params.noParent === true
          ? {
              parentWorktree: params.parentWorktree,
              noParent: params.noParent === true
            }
          : undefined
    })
    const warning = getWorkspaceStatusWarning(
      params.workspaceStatus,
      () => runtime.getUIState().workspaceStatuses
    )
    return { worktree, ...(warning ? { warnings: [warning] } : {}) }
  }
})
